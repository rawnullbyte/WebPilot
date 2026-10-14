#!/usr/bin/env node
/**
 * Smoke test: does the background script actually start?
 *
 * This is the most basic thing that has to work and the hardest to check any
 * other way — a failure here means the extension installs, does nothing, and
 * reports nothing, which is the worst possible failure mode. It would be caused
 * by something innocuous: a module-scope `document` reference (a background
 * script has no DOM), a throw during top-level wiring, a missing API on the
 * `chrome` object.
 *
 * The bundle is evaluated in a deliberately bare sandbox — `chrome` and
 * `console`, and *no* `window`, `document` or `navigator` — so anything that
 * reaches for the DOM fails loudly here rather than silently in the browser.
 */

import assert from "node:assert/strict"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { report, section, test } from "./harness.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")

const bundle = await build({
  entryPoints: [path.join(repo, "src/background/index.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "firefox120",
  alias: { "@": path.join(repo, "src") },
  logLevel: "silent",
})

const CODE = bundle.outputFiles[0].text

/* -------------------------------------------------------------------------- */
/*  A bare MV3-ish environment                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds the sandbox and evaluates the background bundle in it.
 *
 * Every listener registration is recorded so the test can assert on what the
 * script wired up, and the `runtime.onMessage` handler is exposed so requests
 * can be driven through it exactly as Firefox would.
 */
function loadBackground({ storage = {}, hangingFetch = false } = {}) {
  const listeners = {
    message: [],
    connect: [],
    installed: [],
    navigation: [],
    storageChanged: [],
    actionClicked: [],
    tabRemoved: [],
    tabActivated: [],
  }
  const calls = { badge: [], title: [], injected: [], sidebarOpened: 0 }

  const makeEvent = (bucket) => ({
    addListener: (fn) => listeners[bucket].push(fn),
    removeListener: () => {},
    hasListener: () => false,
  })

  const chrome = {
    runtime: {
      onMessage: makeEvent("message"),
      onConnect: makeEvent("connect"),
      onInstalled: makeEvent("installed"),
      lastError: undefined,
      connect: () => ({ onMessage: makeEvent("message"), onDisconnect: makeEvent("connect"), postMessage() {} }),
      sendMessage: async () => ({ ok: true }),
      getURL: (p) => `moz-extension://test/${p}`,
      openOptionsPage: async () => {},
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === "string") return key in storage ? { [key]: storage[key] } : {}
          return { ...storage }
        },
        set: async (obj) => Object.assign(storage, obj),
      },
      onChanged: makeEvent("storageChanged"),
    },
    tabs: {
      get: async (id) => ({ id, url: "https://example.test/", title: "Test", windowId: 1 }),
      query: async () => [{ id: 1, url: "https://example.test/" }],
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab: async () => "data:image/png;base64,",
      onRemoved: makeEvent("tabRemoved"),
      onActivated: makeEvent("tabActivated"),
    },
    scripting: {
      executeScript: async (opts) => {
        calls.injected.push(opts)
        return []
      },
    },
    webNavigation: {
      onCommitted: makeEvent("navigation"),
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: "https://example.test/" }],
    },
    action: {
      setBadgeText: async (o) => calls.badge.push(o),
      setBadgeBackgroundColor: async (o) => calls.badge.push(o),
      setTitle: async (o) => calls.title.push(o),
      onClicked: makeEvent("actionClicked"),
    },
    sidebarAction: {
      open: async () => {
        calls.sidebarOpened++
      },
    },
  }

  const warnings = []
  const sandbox = {
    chrome,
    browser: chrome,
    console: {
      log: () => {},
      info: () => {},
      // Mirrors the real console's methods exactly — a missing one would make
      // the bundle throw on a line that is perfectly valid in a browser, and the
      // failure would look like a product bug rather than a stub gap.
      debug: () => {},
      trace: () => {},
      warn: (...a) => warnings.push(a.join(" ")),
      error: (...a) => warnings.push(a.join(" ")),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Error,
    TypeError,
    String,
    Number,
    Boolean,
    RegExp,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    /*
     * A run is only interesting to these tests while it is *in flight*, and the
     * default stub resolves immediately — so every task finishes before the test
     * can queue anything behind it. `hangingFetch` keeps the request open, which
     * is what a real model call looks like from the background's point of view.
     */
    fetch: hangingFetch
      ? () => new Promise(() => {})
      : async () => new Response("{}", { status: 200 }),
    Response,
    ReadableStream,
    // Deliberately absent: window, document, navigator, location, getComputedStyle.
  }
  sandbox.globalThis = sandbox

  let threw = null
  try {
    vm.createContext(sandbox)
    vm.runInContext(CODE, sandbox, { filename: "background.js" })
  } catch (err) {
    threw = err
  }

  /** Drives a request through the registered onMessage handler. */
  const request = (msg) =>
    new Promise((resolve, reject) => {
      const handler = listeners.message[0]
      if (!handler) return reject(new Error("no onMessage listener was registered"))
      const returned = handler(msg, {}, resolve)
      if (returned !== true && typeof returned !== "object") {
        // Synchronous reply already delivered via sendResponse.
      }
    })

  /** Opens a panel port and returns helpers for driving it. */
  const connectPanel = (surface = "sidebar", tabId = 1) => {
    const received = []
    const handlers = { message: [], disconnect: [] }
    const port = {
      name: "webpilot-panel",
      sender: { tab: { id: tabId } },
      onMessage: { addListener: (fn) => handlers.message.push(fn) },
      onDisconnect: { addListener: (fn) => handlers.disconnect.push(fn) },
      postMessage: (m) => received.push(m),
      disconnect: () => handlers.disconnect.forEach((fn) => fn()),
    }
    listeners.connect.forEach((fn) => fn(port))
    handlers.message.forEach((fn) => fn({ type: "ui/register", surface, tabId }))
    return { port, received, handlers }
  }

  /** Writes everything to the (shared) storage object, as a real shutdown would. */
  const flush = async () => {
    const handler = sandbox.__webpilotFlush
    if (typeof handler === "function") await handler()
  }

  return { threw, listeners, calls, warnings, request, connectPanel, sandbox, storage, flush }
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

section("background startup")

const bg = loadBackground()

await test("evaluates in a DOM-less context without throwing", () => {
  assert.equal(
    bg.threw,
    null,
    `the background script threw on load: ${bg.threw?.message}\n${bg.threw?.stack}`,
  )
})

await test("does not touch the DOM at module scope", () => {
  // The sandbox has no `document` or `window`, so reaching for either would have
  // thrown above. This states the intent explicitly so a future edit that adds
  // one gets a clear failure rather than a confusing "document is not defined".
  assert.equal(bg.threw, null)
  assert.equal(typeof bg.sandbox.document, "undefined")
})

await test("registers the listeners it needs", () => {
  assert.equal(bg.listeners.message.length, 1, "no runtime.onMessage handler")
  assert.equal(bg.listeners.connect.length, 1, "no runtime.onConnect handler")
  assert.equal(bg.listeners.navigation.length, 1, "no webNavigation.onCommitted handler")
  assert.equal(bg.listeners.storageChanged.length, 1, "no storage.onChanged handler")
})

await test("listens for tabs closing, so sessions are not leaked", () => {
  assert.equal(
    bg.listeners.tabRemoved.length,
    1,
    "a closed tab would keep its whole transcript for the life of the browser session",
  )
})

section("requests")

await test("settings/get returns the defaults", async () => {
  const res = await bg.request({ type: "settings/get" })
  assert.ok(res.settings, "no settings in the reply")
  assert.equal(res.settings.approval, "auto", "the default approval mode should be auto")
  assert.equal(typeof res.settings.maxSteps, "number")
  assert.equal(res.settings.endpoint, "")
})

await test("settings/set persists and comes back", async () => {
  const res = await bg.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })
  assert.equal(res.settings.endpoint, "https://x.test/v1")
  assert.equal(res.settings.model, "m")

  const again = await bg.request({ type: "settings/get" })
  assert.equal(again.settings.endpoint, "https://x.test/v1", "settings did not persist")
})

await test("agent/run refuses when nothing is configured", async () => {
  const fresh = loadBackground()
  // A fresh sandbox still has empty default settings.
  const res = await fresh.request({ type: "agent/run", prompt: "do something" })
  assert.equal(res.ok, false)
  assert.match(res.error, /Settings/i, "the refusal should say where to fix it")
})

await test("agent/state reports an idle session", async () => {
  const res = await bg.request({ type: "agent/state" })
  assert.equal(res.session.status, "idle")
  // Length rather than deepEqual: the reply is built inside a vm realm, so its
  // Array prototype differs from this realm's and deepEqual would reject it.
  assert.equal(res.session.steps.length, 0)
  assert.equal(res.session.messages.length, 0)
  assert.equal(res.session.question, null)
})

await test("ui/which-surface reports the sidebar when it exists", async () => {
  const res = await bg.request({ type: "ui/which-surface" })
  assert.equal(res.surface, "sidebar")
})

await test("ui/open-panel opens the sidebar when available", async () => {
  const res = await bg.request({ type: "ui/open-panel" })
  assert.equal(res.ok, true)
  assert.equal(res.surface, "sidebar")
  assert.equal(bg.calls.sidebarOpened, 1)
})

await test("an unknown request is refused, not silently ignored", async () => {
  const res = await bg.request({ type: "nonsense/request" })
  assert.equal(res.ok, false)
  assert.match(res.error, /Unknown request/)
})

await test("a frame/ready announcement is acknowledged", async () => {
  // Content scripts send this on load; an unanswered message logs a rejection
  // in the frame's console.
  const res = await bg.request({ type: "frame/ready", top: true, url: "https://x.test/" })
  assert.equal(res.ok, true)
})

section("no sidebar (Firefox for Android)")

await test("falls back to the in-page panel", async () => {
  // Firefox for Android has no sidebarAction at all, so the popup must not offer
  // one and the fallback must actually inject the panel.
  const android = loadBackground()
  delete android.sandbox.chrome.sidebarAction

  const surface = await android.request({ type: "ui/which-surface" })
  assert.equal(surface.surface, "overlay", "Android should be told there is no sidebar")

  const opened = await android.request({ type: "ui/open-panel" })
  assert.equal(opened.ok, true)
  assert.equal(opened.surface, "overlay")
  assert.ok(
    android.calls.injected.some((c) => (c.files ?? []).includes("src/overlay/overlay.js")),
    "the overlay was not injected as the fallback",
  )
})

section("panels")

await test("a connecting panel is sent its tab's state", async () => {
  const fresh = loadBackground()
  const panel = fresh.connectPanel("sidebar", 1)
  // The send awaits the session restore, so give it a tick to land.
  await new Promise((r) => setTimeout(r, 20))
  const state = panel.received.find((m) => m.type === "agent/state")
  assert.ok(state, `the panel was not sent initial state; got: ${panel.received.map((m) => m.type).join(", ")}`)
  assert.equal(state.tabId, 1, "the snapshot did not say which tab it describes")
  assert.equal(state.session.status, "idle")
})

await test("switching tabs loads that tab's own conversation", async () => {
  /*
   * The whole point of per-tab sessions: a task running in one tab must not
   * appear, or be disturbed, when the user looks at another.
   */
  const fresh = loadBackground()
  const one = fresh.connectPanel("sidebar", 1)
  const two = fresh.connectPanel("sidebar", 2)

  // Give tab 1 a session with something in it.
  await fresh.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })
  await fresh.request({ type: "agent/run", prompt: "do a thing" })
  await new Promise((r) => setTimeout(r, 30))

  // Tab 2 must still look untouched.
  const stateTwo = two.received.filter((m) => m.type === "agent/state").pop()
  assert.equal(stateTwo?.session.status, "idle", "tab 2 inherited tab 1's run")
  assert.equal(stateTwo?.session.steps.length, 0)

  void one
})

await test("a panel is not sent another tab's events", async () => {
  const fresh = loadBackground()
  const one = fresh.connectPanel("sidebar", 1)
  const two = fresh.connectPanel("sidebar", 2)
  one.received.length = 0
  two.received.length = 0

  await fresh.request({ type: "agent/clear", }) // unscoped one-shot → resolves a tab
  await new Promise((r) => setTimeout(r, 20))

  // Whichever tab the one-shot resolved to, only that panel may have heard it.
  const toOne = one.received.filter((m) => m.type === "agent/event").length
  const toTwo = two.received.filter((m) => m.type === "agent/event").length
  assert.ok(
    !(toOne > 0 && toTwo > 0),
    "one tab's event was delivered to a panel showing a different tab",
  )
})

await test("a panel request is answered over its port", async () => {
  const fresh = loadBackground()
  const panel = fresh.connectPanel("sidebar", 1)
  panel.handlers.message.forEach((fn) => fn({ type: "settings/get", id: "r1" }))

  await new Promise((r) => setTimeout(r, 20))

  const reply = panel.received.find((m) => m.type === "reply" && m.id === "r1")
  assert.ok(reply, `no reply came back; got: ${panel.received.map((m) => m.type).join(", ")}`)
  assert.ok(reply.result.settings, "the reply carried no settings")
})

await test("agent/run is refused when a panel exists but no model is set", async () => {
  const fresh = loadBackground()
  fresh.connectPanel("sidebar", 1)
  const res = await fresh.request({ type: "agent/run", prompt: "go" })
  assert.equal(res.ok, false)
  assert.match(res.error, /Settings/i)
})

await test("agent/run is refused when there is no tab at all", async () => {
  const fresh = loadBackground()
  // A sender with no tab, and no window to fall back to.
  fresh.sandbox.chrome.tabs.query = async () => []
  fresh.listeners.message.length = 0
  // Re-register by reloading the sandbox with the changed stub.
  const bare = loadBackground()
  bare.sandbox.chrome.tabs.query = async () => []
  const res = await bare.request({ type: "agent/run", prompt: "go" }).catch((e) => ({ error: e.message }))
  assert.ok(res.error || res.ok === false, "a run with no tab should be refused")
})

section("surviving a background restart")

await test("a session is restored after the background restarts", async () => {
  /*
   * An MV3 background is an event page: Firefox unloads it when idle and starts
   * it again on the next event, taking every in-memory session with it. A panel
   * then reconnects and gets handed an empty session — which is what "the chat
   * randomly resets to a fresh one" actually was.
   *
   * So: run something, discard the whole background, start a new one against the
   * same storage, and check the transcript is still there.
   */
  const storage = {}

  const first = loadBackground({ storage, hangingFetch: true })
  await first.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })
  await first.request({ type: "agent/run", prompt: "remember me" })
  await new Promise((r) => setTimeout(r, 40))
  await first.flush()

  // Everything above is now only on disk.
  const second = loadBackground({ storage })
  const res = await second.request({ type: "agent/state" })

  const session = res.sessions?.find((s) => s.tabId === 1) ?? res.session
  assert.ok(session, `no session after restart; got ${JSON.stringify(res).slice(0, 200)}`)
  assert.ok(
    session.messages.some((m) => m.text === "remember me"),
    "the transcript did not survive the restart",
  )
})

await test("a queued prompt survives a restart", async () => {
  const storage = {}
  // Hanging, so the queue is still a queue when the restart happens.
  const first = loadBackground({ storage, hangingFetch: true })
  await first.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })

  // Queue two while nothing is running, then restart before they drain.
  await first.request({ type: "agent/run", prompt: "first" })
  await first.request({ type: "agent/run", prompt: "second" })
  await new Promise((r) => setTimeout(r, 30))
  await first.flush()

  const second = loadBackground({ storage, hangingFetch: true })
  const res = await second.request({ type: "agent/state" })
  // A one-shot request resolves a tab, so it gets `session`; an unscoped port
  // would get `sessions`. Accept either.
  const session = res.session ?? res.sessions?.find((s) => s.tabId === 1)
  assert.ok(session, `no session after restart; got ${JSON.stringify(res).slice(0, 160)}`)
  assert.ok(
    session.queue.includes("second") || session.messages.some((m) => m.text === "second"),
    `the queued prompt was lost; queue=${JSON.stringify(session.queue)}`,
  )
})

await test("a corrupt store does not stop the extension starting", async () => {
  // A bad value on disk must leave the extension working empty, not refusing to
  // load at all — there is nothing useful to do with it except ignore it.
  const bg = loadBackground({ storage: { "webpilot.sessions": "not-an-array" } })
  assert.equal(bg.threw, null, "a corrupt store took down the background")
  const res = await bg.request({ type: "settings/get" })
  assert.ok(res.settings, "the extension did not start properly")
})

section("queueing")

await test("a request made while busy is queued, not refused", async () => {
  const fresh = loadBackground({ hangingFetch: true })
  fresh.connectPanel("sidebar", 1)
  await fresh.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })

  await fresh.request({ type: "agent/run", prompt: "first" })
  // Immediately, while the first is still starting.
  const res = await fresh.request({ type: "agent/run", prompt: "second" })

  assert.equal(res.ok, true, `the follow-up was refused: ${JSON.stringify(res)}`)
})

await test("a queued prompt appears in the transcript straight away", async () => {
  /*
   * A queue that is invisible until it starts is a queue you cannot tell you are
   * in. The prompt is recorded when it is queued, so the panel shows what you
   * asked and when.
   */
  const fresh = loadBackground()
  fresh.connectPanel("sidebar", 1)
  await fresh.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })

  await fresh.request({ type: "agent/run", prompt: "first" })
  await fresh.request({ type: "agent/run", prompt: "queued one" })
  await new Promise((r) => setTimeout(r, 30))

  const res = await fresh.request({ type: "agent/state" })
  assert.ok(
    res.session.messages.some((m) => m.text === "queued one"),
    "the queued prompt was not recorded",
  )
})

await test("a queued prompt can be removed", async () => {
  const fresh = loadBackground({ hangingFetch: true })
  fresh.connectPanel("sidebar", 1)
  await fresh.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })

  await fresh.request({ type: "agent/run", prompt: "first" })
  await fresh.request({ type: "agent/run", prompt: "take it back" })
  await new Promise((r) => setTimeout(r, 30))

  const removed = await fresh.request({ type: "agent/unqueue", prompt: "take it back" })
  assert.equal(removed.ok, true, "the queued prompt could not be removed")

  const res = await fresh.request({ type: "agent/state" })
  assert.ok(
    !res.session.queue.includes("take it back"),
    "the removed prompt is still queued",
  )
})

await test("stopping clears the queue", async () => {
  // "Stop" means stop. Leaving prompts to fire afterwards would make the button
  // appear not to have worked.
  const fresh = loadBackground()
  fresh.connectPanel("sidebar", 1)
  await fresh.request({ type: "settings/set", patch: { endpoint: "https://x.test/v1", model: "m" } })

  await fresh.request({ type: "agent/run", prompt: "first" })
  await fresh.request({ type: "agent/run", prompt: "and this" })
  await new Promise((r) => setTimeout(r, 30))

  await fresh.request({ type: "agent/stop" })
  const res = await fresh.request({ type: "agent/state" })
  assert.equal(res.session.queue.length, 0, `queue survived a stop: ${JSON.stringify(res.session.queue)}`)
})

section("storage changes")

await test("a rate-limit change is picked up without a restart", () => {
  const fresh = loadBackground()
  let threw = null
  try {
    fresh.listeners.storageChanged[0](
      { "webpilot.settings": { newValue: { rateLimit: 5 } } },
      "local",
    )
  } catch (err) {
    threw = err
  }
  assert.equal(threw, null, `the storage listener threw: ${threw?.message}`)
})

await test("a change in another storage area is ignored", () => {
  const fresh = loadBackground()
  let threw = null
  try {
    fresh.listeners.storageChanged[0]({ something: {} }, "sync")
  } catch (err) {
    threw = err
  }
  assert.equal(threw, null)
})

report()