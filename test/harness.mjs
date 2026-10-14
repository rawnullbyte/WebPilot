/**
 * Test harness for WebPilot's content script.
 *
 * Bundles the real `src/content/page.ts` with esbuild and evaluates it inside a
 * jsdom window, so the tests exercise the shipped code rather than a
 * reimplementation of it.
 *
 * Two things here are load-bearing:
 *
 *  - **Async tests are awaited.** A `try/catch` cannot catch a rejected promise,
 *    so a test whose body contains an `await` would report success no matter
 *    what the assertion said. Every test is awaited, and a rejection fails it.
 *
 *  - **Geometry is stubbed.** jsdom has no layout engine, so every element
 *    measures 0x0. The content script's visibility heuristic keys off real size,
 *    which means an unstubbed jsdom reports *no* visible elements and every
 *    reading test passes vacuously or fails for the wrong reason. Giving each
 *    element a plausible box makes the heuristic meaningful to test.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { JSDOM } from "jsdom"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")

let passed = 0
const failures = []

export async function test(name, fn) {
  try {
    await fn()
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (err) {
    failures.push({ name, err })
    process.stdout.write(`  ✗ ${name}\n`)
    process.stdout.write(`      ${String(err.message ?? err).split("\n").slice(0, 8).join("\n      ")}\n`)
  }
}

export function report() {
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`)
  if (failures.length) process.exit(1)
}

export function section(title) {
  process.stdout.write(`\n${title}\n`)
}

/* -------------------------------------------------------------------------- */
/*  Bundle the real content script once                                        */
/* -------------------------------------------------------------------------- */

const bundle = await build({
  entryPoints: [path.join(repo, "src/content/page.ts")],
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
/*  A frame under test                                                         */
/* -------------------------------------------------------------------------- */

/** Boxes are staggered so overlap-aware logic has something to work with. */
let boxSeed = 0

export function makeFrame(html, { url = "https://example.test/page" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
    // Without this, `window.eval` is unavailable and the bundle would have to be
    // run via window.Function — which executes it in Node's realm, where
    // `location`, `Node` and `getComputedStyle` are not defined.
    runScripts: "outside-only",
  })

  const { window } = dom

  // jsdom logs a "not implemented" notice for these; the script calls them.
  window.scrollBy = () => {}
  window.scrollTo = () => {}
  window.HTMLElement.prototype.scrollIntoView = () => {}

  /**
   * Give every element a real box.
   *
   * Elements the script should treat as invisible are made zero-sized, so the
   * heuristic is exercised through its actual code path rather than bypassed.
   */
  const HIDDEN = new WeakSet()
  boxSeed = 0
  window.Element.prototype.getBoundingClientRect = function () {
    if (HIDDEN.has(this)) {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
    // A typical control, laid out down the page.
    const i = boxSeed++
    const top = i * 24
    return {
      x: 20,
      y: top,
      top,
      left: 20,
      right: 220,
      bottom: top + 20,
      width: 200,
      height: 20,
    }
  }
  window.__markHidden = (el) => HIDDEN.add(el)

  /**
   * jsdom's computed style lacks the default stylesheet a browser applies, so
   * `display` comes back as '' for an unstyled element. The script distinguishes
   * `display:none` from "no opinion", so normalise '' to the browser's usual
   * defaults for the element in question.
   */
  const realGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = (el, pseudo) => {
    const style = realGetComputedStyle(el, pseudo)
    return new Proxy(style, {
      get(target, prop) {
        if (prop === "display") {
          const explicit = target.display
          if (explicit) return explicit
          const tag = el.tagName?.toLowerCase() ?? ""
          // Mirrors the browser default well enough for the purposes here.
          return ["span", "a", "b", "i", "em", "strong", "label"].includes(tag)
            ? "inline"
            : "block"
        }
        if (prop === "visibility") return target.visibility || "visible"
        if (prop === "opacity") return target.opacity || "1"
        if (prop === "clipPath") return target.clipPath || "none"
        if (prop === "pointerEvents") return target.pointerEvents || "auto"
        const v = target[prop]
        return typeof v === "function" ? v.bind(target) : v
      },
    })
  }

  // jsdom has no PointerEvent; the click sequence uses one.
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends window.MouseEvent {
      constructor(type, init = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
        this.isPrimary = init.isPrimary ?? true
      }
    }
  }

  /*
   * jsdom does not implement `document.execCommand`, and the typing path relies
   * on `insertText` to drive the browser's real editing pipeline — the mechanism
   * that makes rich-text editors and `beforeinput`-driven frameworks see the
   * edit. Without a stand-in here, every typing test would exercise only the
   * fallback path and the interesting branch would go unverified.
   *
   * This is a faithful-enough model of the real thing: it removes the selected
   * text, inserts at the caret, fires a cancelable `beforeinput`, applies the
   * change, then fires `input` carrying `inputType: 'insertText'`. That sequence
   * — and especially the `beforeinput` that a framework can cancel — is what
   * code depends on.
   *
   * `window.__execCommandWorks = false` disables it, to test the fallback.
   */
  window.__execCommandWorks = true
  window.__nativeValueDescriptor = (el) => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    return Object.getOwnPropertyDescriptor(proto, 'value')
  }
  window.document.execCommand = function (command, _showUI, value) {
    if (!window.__execCommandWorks) return false
    if (command !== 'insertText') return false

    const el = window.document.activeElement
    if (!el) return false

    const isField = el instanceof window.HTMLInputElement || el instanceof window.HTMLTextAreaElement
    const isEditable = el.getAttribute?.('contenteditable') != null
    if (!isField && !isEditable) return false

    // Types that the editing system refuses to write into; the real one returns
    // false for these too, which is why the direct-write fallback exists.
    if (isField && ['number', 'date', 'range', 'file', 'color'].includes(el.type)) return false

    const text = String(value ?? '')

    const before = new window.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    })
    const allowed = el.dispatchEvent(before)
    if (!allowed) return false // a handler called preventDefault

    if (isEditable) {
      // Replace whatever the selection covers, then place the caret after it.
      const selection = window.getSelection()
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        const node = window.document.createTextNode(text)
        range.insertNode(node)
        range.setStartAfter(node)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      } else {
        el.textContent = (el.textContent ?? '') + text
      }
    } else {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const native = window.__nativeValueDescriptor(el)
      const current = native.get.call(el)
      const next = current.slice(0, start) + text + current.slice(end)
      /*
       * Written through the prototype's descriptor, not by assigning to the
       * element. A real edit happens in the browser engine and never calls a
       * JavaScript setter, which is precisely why it works on a field whose
       * `value` property a framework has replaced — the framework notices on
       * `input` by re-reading. Assigning `el.value` here would call that
       * framework's setter instead and quietly test the wrong thing.
       */
      native.set.call(el, next)
      el.setSelectionRange?.(start + text.length, start + text.length)
    }

    el.dispatchEvent(
      new window.InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      }),
    )
    return true
  }

  // The agent registers a listener and announces itself on load.
  let listener = null
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn } },
      sendMessage: () => Promise.resolve(),
    },
  }
  window.browser = window.chrome

  window.eval(CODE)

  if (!listener) throw new Error("the content script never registered a message listener")

  /** Sends a message and resolves with the reply. */
  const ask = (msg) =>
    new Promise((resolve) => {
      const responded = listener(msg, {}, resolve)
      if (responded === false) {
        // A synchronous listener calls sendResponse before returning false.
      }
    })

  const read = () => ask({ type: "frame/read" }).then((r) => r.frame)
  const exec = (op) => ask({ type: "frame/exec", op, frameId: 0 }).then((r) => r.result)

  return {
    window,
    document: window.document,
    read,
    exec,
    ask,
    markHidden: window.__markHidden,
    /** Reads and returns the flat list of nodes, for convenient assertions. */
    async flatNodes() {
      const frame = await read()
      return { frame, nodes: flatten(frame.nodes) }
    },
  }
}

export function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes ?? []) {
    out.push({ ...n, depth })
    if (n.children) flatten(n.children, depth + 1, out)
  }
  return out
}
