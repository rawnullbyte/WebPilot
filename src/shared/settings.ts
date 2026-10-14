import type { Settings } from './types'

// Re-exported so the rest of the codebase can import settings types and helpers
// from one place rather than reaching across into `types` as well.
export type { Settings }

export type { ApprovalMode } from './types'

/**
 * Firefox exposes the promise-based `browser` namespace; Chromium builds and
 * some embedded contexts only have `chrome`. Both are promise-capable in
 * Firefox either way, so one alias covers every surface we ship to.
 */
export const ext = (
  (globalThis as any).browser ?? (globalThis as any).chrome
) as typeof chrome

export const DEFAULT_SYSTEM_PROMPT = `You are WebPilot, an agent that operates a real web browser on the user's behalf.

You are given a structured description of the page the user is looking at: its URL and title, the visible text, and a numbered tree of interactive elements. Every interactive element has a ref such as \`f0:n12\` — frame 0, node 12. You act on the page only by calling tools with those refs.

How to work:
- Read before you act. The page description is a snapshot; if it looks stale, or you need a part of the page that was truncated, call \`read_page\` to get a fresh one.
- Prefer \`click\` with a ref over guessing at coordinates.
- Take one action, then look at what came back. Do not fire off a batch of speculative actions.
- To fill a field, use \`type\` with that field's ref. Pass \`clear: true\` to empty it first, and \`submit: true\` to press Enter afterwards.
- After a navigation or a form submit the refs are re-issued. Call \`read_page\` before acting again.
- If you need to see more of a long page, \`scroll\` and then \`read_page\`.

Judgement:
- If you are blocked by a captcha, a login wall, a paywall or a payment step, stop and say plainly what you need from the user. Do not try to defeat it.
- Never invent credentials, card numbers, addresses or other personal data. Only use personal data the user gave you in this conversation.
- If two elements could match, prefer the one whose context best fits the user's request, and say which you chose.
- If the task is impossible on this page, say so and explain what you saw, rather than clicking around hopefully.

Finishing:
- When the task is done, call \`finish\` with a short plain-language summary: what you did and what you found. That text is what the user reads, so make it the answer, not a description of your process.`

export const DEFAULT_SETTINGS: Settings = {
  endpoint: '',
  apiKey: '',
  model: '',
  temperature: 0.2,
  // The user asked to start fully autonomous; every mode stays available in
  // Settings and can be changed per task.
  approval: 'auto',
  vision: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  extraHeaders: '',
  rateLimit: 120,
  // On by default: seeing the reasoning is what makes a slow step legible
  // instead of alarming, and users can turn it off in Settings.
  showThinking: true,
  /*
   * Off by default, deliberately. Everything else WebPilot does is expressed as
   * acting on a page through its own controls; this hands the model a
   * general-purpose programming environment inside any site the user visits.
   * That is worth an explicit yes.
   */
  allowScripting: false,
}

const KEY = 'webpilot.settings'

/**
 * Settings live in `storage.local`, never `storage.sync`: the API key must not
 * leave the device, and Firefox for Android's sync storage has historically
 * been unreliable. A half-synced config is worse than none.
 */
export async function loadSettings(): Promise<Settings> {
  const stored = await ext.storage.local.get(KEY)
  const raw = stored?.[KEY] as Partial<Settings> | undefined
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await ext.storage.local.set({ [KEY]: next })
  return next
}

/** True when the extension has enough configured to attempt a request. */
export function isConfigured(s: Settings): boolean {
  return Boolean(s.endpoint.trim() && s.model.trim())
}

/**
 * Normalises whatever the user typed into a usable base URL. People paste
 * everything from `api.openai.com` to a full chat-completions path, so accept
 * all of it and reduce it to the `/v1`-style root.
 */
export function normalizeEndpoint(endpoint: string): string {
  let e = endpoint.trim()
  if (!e) return ''
  if (!/^https?:\/\//i.test(e)) e = `https://${e}`
  e = e.replace(/\/+$/, '')
  // Strip a pasted full path back to its version root.
  e = e.replace(/\/(chat\/completions|completions|models|embeddings)$/i, '')
  return e
}

/** Parses the `Name: value` textarea into a header object. */
export function parseExtraHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at <= 0) continue
    const name = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (name) out[name] = value
  }
  return out
}