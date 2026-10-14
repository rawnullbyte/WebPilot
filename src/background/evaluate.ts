/**
 * Running JavaScript in a page.
 *
 * This is the escape hatch. The structured page read and the `click`/`type`
 * tools cover most of what an agent needs, but they describe a page the way a
 * person sees it — and some work is not like that. Reading a table out of the
 * DOM, calling a framework's own API, waiting on a specific internal condition,
 * pulling a value out of app state: those need code, not a click.
 *
 * Two execution worlds, and the difference matters:
 *
 *  - **ISOLATED** (the default) runs alongside the page without sharing its
 *    globals. The DOM is shared, so it can read and change the page, but the
 *    page's own JavaScript — `window.React`, jQuery, an app object — is not
 *    visible, and the page cannot see this code either.
 *
 *  - **MAIN** runs as if the page had run it itself. That is what makes
 *    `window.__NEXT_DATA__`, `jQuery`, a global store or a site's own helper
 *    functions reachable. It is also the world where the page can read,
 *    intercept and interfere with the code, so it is opt-in per call.
 *
 * The injection goes through `scripting.executeScript` rather than the content
 * script, because MAIN is only reachable that way. That also means code runs
 * even in frames that have no content script of their own.
 */

import { ext } from '@/shared/settings'

export type ScriptWorld = 'ISOLATED' | 'MAIN'

export type ScriptOutcome = {
  ok: boolean
  /** The value the code produced, already stringified for the model. */
  value?: string
  error?: string
  /** Console output the code produced, when any. */
  logs?: string
  /** True when the result had to be truncated. */
  truncated?: boolean
}

/**
 * What `executeScript` returns for one frame.
 *
 * Declared here rather than taken from `@types/chrome`, which omits `error` —
 * Firefox populates it with a per-frame failure (a syntax error in the injected
 * function, for instance) where Chrome leaves it undefined. Relying on the
 * bundled type would silently drop the only diagnostic Firefox gives.
 */
type InjectionResult = {
  frameId?: number
  result?: unknown
  error?: { message?: string }
}

/** Wall-clock ceiling on one evaluation, in milliseconds. */
const EVAL_TIMEOUT_MS = 15_000

/** Cap on what comes back, so a huge result cannot swamp the model's context. */
const MAX_RESULT_CHARS = 20_000

/**
 * The function injected into the page.
 *
 * Everything it needs is passed through `args`, because `executeScript`
 * serialises this function — closures and outer scope do not survive the trip.
 * It must therefore be entirely self-contained, which is why it re-derives
 * `AsyncFunction` rather than importing a helper.
 *
 * It always returns a `{ ok, value, error, logs }` envelope of plain strings.
 * That is deliberate: Firefox clones results with the structured-clone
 * algorithm, which rejects DOM nodes, functions and class instances outright —
 * returning the raw value would fail on the most interesting results. Stringify
 * inside the page, where the value is still live, and the trip back is safest.
 */
function injected(code: string, timeoutMs: number) {
  return (async () => {
    const logs: string[] = []
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }

    // Capture console output: a script that logs its findings is a normal way to
    // work, and the model should see what it printed rather than only the
    // return value.
    const capture = (level: string) =>
      (...parts: unknown[]) => {
        if (logs.length < 100) {
          try {
            logs.push(`[${level}] ${parts.map((p) => safeString(p)).join(' ')}`)
          } catch {
            /* ignore */
          }
        }
      }

    function safeString(value: unknown): string {
      try {
        if (typeof value === 'string') return value
        if (value instanceof Element) return `<${value.tagName.toLowerCase()}>`
        if (value instanceof Error) return `${value.name}: ${value.message}`
        if (typeof value === 'bigint') return `${value}n`
        if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
        if (value === undefined) return 'undefined'
        if (value === null) return 'null'
        const json = JSON.stringify(value)
        return json === undefined ? String(value) : json
      } catch {
        try {
          return String(value)
        } catch {
          return '[unserialisable]'
        }
      }
    }

    /** Turns whatever the code returned into text the model can read. */
    function present(value: unknown): string {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      if (typeof value === 'string') return value
      if (value instanceof Element) return value.outerHTML
      if (value instanceof NodeList || value instanceof HTMLCollection) {
        return `[${value.length} element(s)]\n` +
          [...value].slice(0, 50).map((el) => (el as Element).outerHTML ?? safeString(el)).join('\n')
      }
      if (Array.isArray(value)) {
        // An array of nodes is a common and useful shape; show the elements.
        if (value.length && value.every((v) => v instanceof Element)) {
          return `[${value.length} element(s)]\n` + value.slice(0, 50).map((el) => el.outerHTML).join('\n')
        }
        return safeString(value)
      }
      return safeString(value)
    }

    try {
      console.log = capture('log')
      console.info = capture('info')
      console.warn = capture('warn')
      console.error = capture('error')

      /*
       * The code is wrapped in an async function so `await` works at the top
       * level, and in a `return` so that a trailing expression is the result —
       * `document.title` should evaluate to the title, the way it would in a
       * console.
       */
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
      ) => (...args: unknown[]) => Promise<unknown>

      const body = `return (async () => { ${code}\n})()`
      const fn = new AsyncFunction(body)

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs} ms.`)),
          timeoutMs,
        )
      })

      let value: unknown
      try {
        // A timeout can only abandon the wait, not the execution — code that
        // never yields will still block the frame. It is here so that an
        // awaiting-forever script reports a clear failure instead of hanging the
        // agent's step budget in silence.
        value = await Promise.race([fn(), timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }

      let text = present(value)
      let truncated = false
      if (text.length > 40000) {
        text = text.slice(0, 40000)
        truncated = true
      }

      return {
        ok: true,
        value: text,
        logs: logs.length ? logs.join('\n') : '',
        truncated,
      }
    } catch (err) {
      return {
        ok: false,
        value: '',
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        logs: logs.length ? logs.join('\n') : '',
      }
    } finally {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
      console.info = original.info
    }
  })()
}

/**
 * Runs `code` in one frame and returns what it produced.
 *
 * `frameIds` is validated against the frames that currently exist, because
 * `executeScript` throws a confusing error for an unknown frame id and the
 * common cause — a stale reference to a frame that navigated away — deserves a
 * clearer answer.
 */
export async function runScript(
  tabId: number,
  frameId: number,
  code: string,
  world: ScriptWorld = 'ISOLATED',
): Promise<ScriptOutcome> {
  if (!code.trim()) return { ok: false, error: 'No code was given.' }

  const attempt = async (target: ScriptWorld) => {
    const results = await ext.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: target,
      func: injected,
      args: [code, EVAL_TIMEOUT_MS - 500],
    })
    return (results as InjectionResult[] | undefined)?.[0]
  }

  let result: InjectionResult | undefined
  let usedWorld = world

  try {
    result = await attempt(world)
  } catch (err) {
    /*
     * MAIN is not available on every Firefox release — `world` arrived after the
     * `scripting` API itself did. Rather than refuse, fall back to ISOLATED and
     * say so, because the code will often still work: the DOM is shared, and most
     * useful snippets only touch the DOM.
     */
    if (world === 'MAIN' && /world|MAIN|unsupported|invalid/i.test(String(err))) {
      usedWorld = 'ISOLATED'
      try {
        result = await attempt('ISOLATED')
      } catch (err2) {
        return { ok: false, error: describeInjectionFailure(err2) }
      }
    } else {
      return { ok: false, error: describeInjectionFailure(err) }
    }
  }

  if (!result) return { ok: false, error: 'The frame did not return a result.' }

  // Firefox reports a per-frame error here; Chrome does not populate this at all.
  if (result.error) {
    return { ok: false, error: `The code failed: ${result.error.message ?? String(result.error)}` }
  }

  const payload = result.result as
    | { ok: boolean, value?: string, error?: string, logs?: string, truncated?: boolean }
    | undefined

  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'The frame returned nothing usable.' }
  }

  if (usedWorld !== world) {
    return {
      ...payload,
      value: payload.value,
      error: payload.error,
      logs: [
        `Note: MAIN world was unavailable, so this ran isolated from the page's own JavaScript. ` +
          `Page globals are not reachable in this run.`,
        payload.logs,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  return payload
}

/** Turns an executeScript rejection into something a person can act on. */
function describeInjectionFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/no tab with id|could not establish|invalid tab/i.test(message)) {
    return 'That tab is gone.'
  }
  if (/frame/i.test(message)) {
    return 'That frame is gone — it may have navigated. Read the page again.'
  }
  if (/permission|host/i.test(message)) {
    return `WebPilot does not have permission to run code on this page. (${message})`
  }
  if (/missing host permission/i.test(message)) {
    return 'WebPilot cannot run code on this page — it may be a browser or extension page.'
  }
  return `Could not run code here: ${message}`
}

/**
 * Trims a result to something that will not swamp the conversation.
 *
 * Applied by the caller rather than here so the truncation is visible in the
 * step the user sees, which is the difference between "the page is bigger than
 * this" and "the agent silently lost half the data".
 */
export function clampResult(outcome: ScriptOutcome): ScriptOutcome {
  if (!outcome.value || outcome.value.length <= MAX_RESULT_CHARS) return outcome
  return {
    ...outcome,
    value: outcome.value.slice(0, MAX_RESULT_CHARS),
    truncated: true,
  }
}