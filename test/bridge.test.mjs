#!/usr/bin/env node
/**
 * Tests for the page bridge — turning "one tab" into "one readable page".
 *
 * This is the seam between the agent and the pages it works on, and it is where
 * a mistake is least visible: the content script can be perfect and the agent
 * loop can be perfect while the bridge silently discards everything between
 * them. That is exactly what happened during development — `readFrame()` reports
 * a placeholder frame id because a content script cannot know its own, and the
 * bridge filtered on that placeholder, so *every* frame was dropped and the model
 * was shown a blank page. Both sides' own tests passed.
 *
 * So these tests drive `readPage` end-to-end with a stubbed browser: real
 * content-script replies in, rendered prompt text out.
 */

import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { report, section, test } from "./harness.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")

/* -------------------------------------------------------------------------- */
/*  Stub browser                                                               */
/* -------------------------------------------------------------------------- */

function stubBrowser({ frames, replies, tab }) {
  const sent = []
  const chrome = {
    tabs: {
      get: async (id) => ({ id, ...tab }),
      sendMessage: async (tabId, message, opts) => {
        sent.push({ tabId, message, frameId: opts?.frameId })
        const reply = replies(opts?.frameId ?? 0, message)
        if (reply === undefined) {
          // Mirrors Firefox: a frame with no content script rejects.
          throw new Error("Could not establish connection. Receiving end does not exist.")
        }
        return reply
      },
    },
    webNavigation: { getAllFrames: async () => frames },
    scripting: { executeScript: async () => [] },
  }
  return { chrome, sent }
}

/**
 * The bridge reads the extension API once at module scope, so each stub needs a
 * fresh module instance. A cache-busting fragment keeps them isolated.
 */
let importCounter = 0
async function loadBridge(browser) {
  globalThis.chrome = browser.chrome
  globalThis.browser = browser.chrome
  const bundle = await build({
    entryPoints: [path.join(repo, "src/background/page-bridge.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    alias: { "@": path.join(repo, "src") },
    logLevel: "silent",
  })
  const code = bundle.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${++importCounter}`)
}

/** A content-script reply shaped exactly as the real one. */
function frameReply(overrides = {}) {
  return {
    ok: true,
    frame: {
      // What the content script actually reports: it cannot know its own id.
      frameId: -1,
      url: "https://example.test/page",
      title: "Example",
      hidden: false,
      viewport: {
        scrollX: 0,
        scrollY: 0,
        innerWidth: 1280,
        innerHeight: 800,
        scrollWidth: 1280,
        scrollHeight: 2000,
        dpr: 1,
      },
      text: "Find a hotel in Lisbon",
      nodes: [
        {
          id: "n0",
          role: "form",
          name: "Search hotels",
          inView: true,
          children: [
            {
              id: "n1",
              role: "searchbox",
              name: "City",
              value: "Lisbon",
              inView: true,
              rect: { x: 20, y: 100, w: 200, h: 20 },
            },
          ],
        },
      ],
      truncated: false,
      ...overrides,
    },
  }
}

const topOnly = [{ frameId: 0, parentFrameId: -1, url: "https://example.test/page" }]
const tab = { url: "https://example.test/page", title: "Example" }

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

section("reading a page")

await test("keeps the top frame", async () => {
  // The regression guard for the placeholder-id bug: with the filter in place,
  // `frames` came back empty and the model saw nothing at all.
  const browser = stubBrowser({ frames: topOnly, replies: () => frameReply(), tab })
  const bridge = await loadBridge(browser)

  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 1, "the top frame was discarded")
  assert.equal(snapshot.frames[0].frameId, 0, "the reported frame id was not stamped on")
})

await test("prefixes element refs with the frame id", async () => {
  const browser = stubBrowser({ frames: topOnly, replies: () => frameReply(), tab })
  const bridge = await loadBridge(browser)

  const snapshot = await bridge.readPage(1)
  const form = snapshot.frames[0].nodes[0]
  assert.equal(form.id, "f0:n0", "refs must be page-wide addressable, not frame-local")
  assert.equal(form.children[0].id, "f0:n1")
})

await test("reads an iframe and keeps it distinct", async () => {
  // The whole reason the bridge exists: a form inside an iframe is a different
  // document with its own ref namespace.
  const browser = stubBrowser({
    frames: [
      ...topOnly,
      { frameId: 3, parentFrameId: 0, url: "https://widgets.example.test/booking" },
    ],
    replies: (frameId) =>
      frameId === 3
        ? frameReply({
            url: "https://widgets.example.test/booking",
            title: "Booking",
            text: "Check availability",
            nodes: [{ id: "n0", role: "button", name: "Check", inView: true }],
          })
        : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 2, "the iframe was not read")
  const ids = snapshot.frames.flatMap((f) => f.nodes.map((n) => n.id))
  assert.ok(ids.includes("f0:n0"), `top frame refs missing; got ${ids.join(", ")}`)
  assert.ok(ids.includes("f3:n0"), `iframe refs missing; got ${ids.join(", ")}`)
})

await test("renders the page so the model can see it", async () => {
  // The end-to-end assertion: real content-script reply in, prompt text out.
  const browser = stubBrowser({ frames: topOnly, replies: () => frameReply(), tab })
  const bridge = await loadBridge(browser)

  const text = bridge.renderSnapshot(await bridge.readPage(1))
  assert.match(text, /Find a hotel in Lisbon/, "the page text never reached the prompt")
  assert.match(text, /\[f0:n1\]/, "no addressable element reached the prompt")
  assert.match(text, /"City"/, "no element name reached the prompt")
  assert.match(text, /value="Lisbon"/, "no element value reached the prompt")
})

await test("drops a hidden frame", async () => {
  const browser = stubBrowser({
    frames: topOnly,
    replies: () => frameReply({ hidden: true, text: "", nodes: [] }),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 0, "a frame that rendered nothing should not be reported")
})

await test("drops an empty about:blank frame", async () => {
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 1, parentFrameId: 0, url: "about:blank" }],
    replies: (frameId) =>
      frameId === 1 ? frameReply({ url: "about:blank", text: "", nodes: [] }) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 1, "the about:blank placeholder was reported")
})

await test("drops a tracker iframe that rendered nothing", async () => {
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 1, parentFrameId: 0, url: "https://www.googletagmanager.com/ns.html" }],
    replies: (frameId) =>
      frameId === 1
        ? frameReply({ url: "https://www.googletagmanager.com/ns.html", text: "", nodes: [] })
        : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 1, "an analytics frame was reported as page content")
})

await test("survives a frame with no content script", async () => {
  // A frame created before the extension loaded has no listener, and messaging
  // it rejects. That must not take down the whole read.
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 2, parentFrameId: 0, url: "https://other.test/embed" }],
    replies: (frameId) => (frameId === 2 ? undefined : frameReply()),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames.length, 1, "the readable frame was lost with the unreadable one")
})

await test("puts the top frame first", async () => {
  // The top frame carries the page's identity and its main controls, so it
  // should be the part that survives any truncation.
  const browser = stubBrowser({
    frames: [
      { frameId: 5, parentFrameId: 0, url: "https://widgets.test/a" },
      { frameId: 0, parentFrameId: -1, url: "https://example.test/page" },
    ],
    replies: (frameId) =>
      frameId === 5 ? frameReply({ url: "https://widgets.test/a", nodes: [] }) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.frames[0].frameId, 0, "the top frame was not ordered first")
})

/* -------------------------------------------------------------------------- */
/*  Executing                                                                  */
/* -------------------------------------------------------------------------- */

section("executing an operation")

const execReply = (frameId) => ({ ok: true, result: { ok: true, message: `acted in frame ${frameId}` } })

await test("routes a ref to the frame it names", async () => {
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 3, parentFrameId: 0, url: "https://widgets.test/a" }],
    replies: (frameId, message) =>
      message.type === "frame/exec" ? execReply(frameId) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  await bridge.execOp(1, { op: "click", ref: "f3:n4" })

  const exec = browser.sent.find((s) => s.message.type === "frame/exec")
  assert.ok(exec, "no exec was sent")
  assert.equal(exec.frameId, 3, "the action went to the wrong frame")
  assert.equal(exec.message.op.ref, "n4", "the frame prefix was not stripped before dispatch")
})

await test("sends a frame-free op to the top frame", async () => {
  const browser = stubBrowser({
    frames: topOnly,
    replies: (frameId, message) =>
      message.type === "frame/exec" ? execReply(frameId) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  await bridge.execOp(1, { op: "scroll", direction: "down" })
  const exec = browser.sent.find((s) => s.message.type === "frame/exec")
  assert.equal(exec.frameId, 0)
})

await test("accepts a bare ref and assumes the top frame", async () => {
  // A model that drops the `f0:` prefix should still work rather than fail with
  // an error it cannot act on.
  const browser = stubBrowser({
    frames: topOnly,
    replies: (frameId, message) =>
      message.type === "frame/exec" ? execReply(frameId) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  const outcome = await bridge.execOp(1, { op: "click", ref: "n7" })
  assert.equal(outcome.ok, true)
  const exec = browser.sent.find((s) => s.message.type === "frame/exec")
  assert.equal(exec.frameId, 0)
  assert.equal(exec.message.op.ref, "n7")
})

await test("reports the page's own refusal, not a phantom navigation", async () => {
  // A stale ref and a vanished frame are different failures with different
  // fixes. Reporting "the page navigated" for a failed click sends the agent to
  // re-read a page that never changed.
  const browser = stubBrowser({
    frames: topOnly,
    replies: (frameId, message) =>
      message.type === "frame/exec"
        ? { ok: false, error: 'Unknown reference "n9". Read the page again.' }
        : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  const outcome = await bridge.execOp(1, { op: "click", ref: "f0:n9" })
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /Unknown reference/, "the page's own message was replaced")
  assert.equal(outcome.stale, false, "a refusal is not a navigation")
})

await test("treats an unanswered frame as a navigation", async () => {
  const browser = stubBrowser({ frames: topOnly, replies: () => undefined, tab })
  const bridge = await loadBridge(browser)

  const outcome = await bridge.execOp(1, { op: "click", ref: "f0:n1" })
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /navigated/i)
  assert.equal(outcome.stale, true, "a vanished frame should force a re-read")
})

await test("marks a click stale and typing not, unless submitted", async () => {
  const browser = stubBrowser({
    frames: topOnly,
    replies: (frameId, message) =>
      message.type === "frame/exec" ? execReply(frameId) : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)

  assert.equal((await bridge.execOp(1, { op: "click", ref: "f0:n1" })).stale, true)
  assert.equal((await bridge.execOp(1, { op: "type", ref: "f0:n1", text: "x" })).stale, false)
  assert.equal(
    (await bridge.execOp(1, { op: "type", ref: "f0:n1", text: "x", submit: true })).stale,
    true,
  )
  assert.equal((await bridge.execOp(1, { op: "scroll", direction: "down" })).stale, false)
})

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

section("rendering the prompt")

await test("shows one region for a single-frame page", async () => {
  const browser = stubBrowser({ frames: topOnly, replies: () => frameReply(), tab })
  const bridge = await loadBridge(browser)
  const text = bridge.renderSnapshot(await bridge.readPage(1))
  assert.match(text, /MAIN PAGE/)
  assert.ok(!/EMBEDDED FRAME/.test(text), "a single-frame page should not be split into regions")
})

await test("labels an embedded frame so the model knows where it is", async () => {
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 3, parentFrameId: 0, url: "https://widgets.example.test/booking" }],
    replies: (frameId) =>
      frameId === 3
        ? frameReply({
            url: "https://widgets.example.test/booking",
            text: "Check availability",
            nodes: [{ id: "n0", role: "button", name: "Check", inView: true }],
          })
        : frameReply(),
    tab,
  })
  const bridge = await loadBridge(browser)
  const text = bridge.renderSnapshot(await bridge.readPage(1))

  assert.match(text, /MAIN PAGE/)
  assert.match(text, /EMBEDDED FRAME \(f3\)/, "the iframe was not labelled with its ref prefix")
  assert.match(text, /widgets\.example\.test/, "the iframe's URL was not shown")
  assert.match(text, /\[f3:n0\]/, "the iframe's controls were not shown")
})

await test("notes when the page was too large to read fully", async () => {
  const browser = stubBrowser({
    frames: topOnly,
    replies: () => frameReply({ truncated: true }),
    tab,
  })
  const bridge = await loadBridge(browser)
  const text = bridge.renderSnapshot(await bridge.readPage(1))
  assert.match(text, /too large to read in full/, "truncation must be disclosed, not hidden")
})

await test("reports a frame that exists but could not be read", async () => {
  /*
   * A frame that yields nothing is otherwise indistinguishable from a frame that
   * is not there — and the difference decides what the agent should do. An
   * element missing from a frame it *did* read means the page changed; an element
   * missing from one it could not read means it is blind to that part of the page
   * and should say so rather than hunting for a workaround.
   *
   * This is the shape of a real page that defeated it: an `<iframe src="">` the
   * site populates later, which produced a transcript of retries, scrolls and Tab
   * presses against references that were never going to resolve.
   */
  const browser = stubBrowser({
    frames: [
      ...topOnly,
      { frameId: 9, parentFrameId: 0, url: "https://widgets.example.test/quiz" },
    ],
    // The iframe has no content script: messaging it rejects.
    replies: (frameId) => (frameId === 9 ? undefined : frameReply()),
    tab,
  })
  const bridge = await loadBridge(browser)

  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.unreadable.length, 1, "the unreadable frame was not recorded")
  assert.equal(snapshot.unreadable[0].frameId, 9)

  const text = bridge.renderSnapshot(snapshot)
  assert.match(text, /could not be read/i, "the prompt never mentions the unreadable frame")
  assert.match(text, /f9/, "the unreadable frame is not identified by its reference prefix")
  assert.match(text, /NOT available to you/i, "the model is not warned that the content is missing")
})

await test("does not report an empty tracker frame as unreadable", async () => {
  // Analytics frames are meant to be empty, and listing them would train the
  // model to ignore the section that matters.
  const browser = stubBrowser({
    frames: [...topOnly, { frameId: 4, parentFrameId: 0, url: "https://www.googletagmanager.com/ns.html" }],
    replies: (frameId) => (frameId === 4 ? undefined : frameReply()),
    tab,
  })
  const bridge = await loadBridge(browser)
  const snapshot = await bridge.readPage(1)
  assert.equal(snapshot.unreadable.length, 0, `a tracker frame was reported: ${JSON.stringify(snapshot.unreadable)}`)
})

await test("marks an off-screen element", async () => {
  const browser = stubBrowser({
    frames: topOnly,
    replies: () => frameReply({ nodes: [{ id: "n0", role: "button", name: "Far", inView: false }] }),
    tab,
  })
  const bridge = await loadBridge(browser)
  const text = bridge.renderSnapshot(await bridge.readPage(1))
  assert.match(text, /\[off-screen\]/, "the model was not told the element needs scrolling to")
})

report()