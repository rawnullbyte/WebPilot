import { normalizeEndpoint, parseExtraHeaders, type Settings } from '@/shared/settings'

/* -------------------------------------------------------------------------- */
/*  Wire types (the subset of the OpenAI schema we actually use)               */
/* -------------------------------------------------------------------------- */

export type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ContentPart =
  | { type: 'text', text: string }
  | { type: 'image_url', image_url: { url: string, detail?: 'auto' | 'low' | 'high' } }

export type WireMessage =
  | { role: 'system' | 'user', content: string | ContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string, type: 'function', function: { name: string, arguments: string } }[]
    }
  | { role: 'tool', tool_call_id: string, content: string }

export type ToolCall = {
  id: string
  name: string
  /** Raw JSON string as the model emitted it; parsed by the caller. */
  arguments: string
}

export type ChatResult = {
  content: string
  toolCalls: ToolCall[]
  /** Why generation stopped, straight from the provider. */
  finishReason: string | null
  /** The model's reasoning, when the provider reports it. Never re-sent. */
  reasoning?: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Request plumbing                                                           */
/* -------------------------------------------------------------------------- */

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  // Local runners (Ollama, LM Studio, llama.cpp) frequently accept any key or
  // none at all, so only send the header when there is something to send.
  if (s.apiKey.trim()) h.Authorization = `Bearer ${s.apiKey.trim()}`
  Object.assign(h, parseExtraHeaders(s.extraHeaders))
  return h
}

function url(s: Settings, path: string): string {
  return `${normalizeEndpoint(s.endpoint)}${path}`
}

/**
 * Turns a transport- or protocol-level failure into something a person can act
 * on. "Failed to fetch" is the single most common error here and it means
 * something specific that is worth spelling out.
 */
function describeFailure(err: unknown, s: Settings): LlmError {
  if (err instanceof LlmError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new LlmError('Stopped.')
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new LlmError(
      'The endpoint stopped responding.',
      undefined,
      'It accepted the request and then sent nothing for a while. It may be overloaded, or the model may have crashed — try again, or pick a smaller model.',
    )
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)/i
      .test(normalizeEndpoint(s.endpoint))
    return new LlmError(
      `Could not reach ${normalizeEndpoint(s.endpoint) || 'the endpoint'}.`,
      undefined,
      local
        ? 'The model server is not answering. Check that it is running, and that it allows requests from a browser extension (for Ollama, start it with OLLAMA_ORIGINS=*).'
        : 'Check the base URL, that the machine is online, and that the server allows browser requests (CORS).',
    )
  }
  return new LlmError(msg)
}

/**
 * Maps an HTTP status to a cause and a fix.
 *
 * The hint always leads with the likely cause, and *appends* the provider's own
 * message when there is one. Choosing between them is tempting and wrong: the
 * advice is what tells the user where to look, and the provider's words are the
 * evidence. Discarding either leaves the message less useful — a 404 whose hint
 * is just "Not Found" sends the user hunting, and a 400 that says only "tools not
 * supported" never mentions that the model itself is the problem.
 */
function describeStatus(status: number, body: string): LlmError {
  const provided = extractProviderMessage(body)
  const withDetail = (advice: string) =>
    provided ? `${advice} The endpoint said: ${truncateDetail(provided)}` : advice

  switch (true) {
    case status === 401 || status === 403:
      return new LlmError(
        `The endpoint rejected the API key (HTTP ${status}).`,
        status,
        withDetail(
          'Check the key in Settings. Some providers expect a different header — you can add one in the extra headers field.',
        ),
      )
    case status === 404:
      return new LlmError(
        'No chat-completions route at that address (HTTP 404).',
        status,
        withDetail(
          'The base URL usually needs to end in /v1 — for example https://api.openai.com/v1.',
        ),
      )
    case status === 429:
      return new LlmError(
        'The endpoint is rate-limiting this key (HTTP 429).',
        status,
        withDetail(
          'Wait a moment and try again, or lower the requests-per-minute limit in Settings.',
        ),
      )
    case status === 400 || status === 422:
      return new LlmError(
        `The endpoint rejected the request (HTTP ${status}).`,
        status,
        withDetail(
          'This usually means the model does not accept tool calling, or the model name is wrong.',
        ),
      )
    case status >= 500:
      return new LlmError(
        `The endpoint returned a server error (HTTP ${status}).`,
        status,
        withDetail('That is a problem on the server side. Try again shortly.'),
      )
    default:
      return new LlmError(
        `The endpoint returned HTTP ${status}.`,
        status,
        provided ? `The endpoint said: ${truncateDetail(provided)}` : undefined,
      )
  }
}

/** Keeps a provider's error text to something that fits in the UI. */
function truncateDetail(s: string, max = 240): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** Pulls the human-readable part out of whatever error shape a provider uses. */
function extractProviderMessage(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body)
    const e = parsed?.error
    if (typeof e === 'string') return e
    if (e?.message) return String(e.message)
    if (parsed?.message) return String(parsed.message)
    if (parsed?.detail) {
      return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)
    }
  } catch {
    // Not JSON — often an HTML error page from a misconfigured proxy.
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return text.slice(0, 300)
  }
  return ''
}

/** Retries only what is worth retrying: rate limits and 5xx. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  signal: AbortSignal,
  attempts = 3,
): Promise<Response> {
  let last: LlmError | null = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch()
      if (res.ok || !RETRYABLE.has(res.status)) return res
      const body = await res.text()
      last = describeStatus(res.status, body)
      if (i === attempts - 1) throw last
      // Respect Retry-After when the provider sends one.
      const after = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** i
      await sleep(Math.min(wait, 8000), signal)
    } catch (err) {
      if (err instanceof LlmError) {
        if (!RETRYABLE.has(err.status ?? 0) || i === attempts - 1) throw err
        last = err
      } else {
        if (signal.aborted) throw new LlmError('Stopped.')
        if (i === attempts - 1) throw err
      }
      await sleep(500 * 2 ** i, signal)
    }
  }
  throw last ?? new LlmError('Request failed.')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmError('Stopped.'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new LlmError('Stopped.'))
      },
      { once: true },
    )
  })
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export type ChatOptions = {
  messages: WireMessage[]
  tools?: ToolSchema[]
  signal: AbortSignal
  /** Called with each streamed token of assistant prose, for live rendering. */
  onToken?: (text: string) => void
  /**
   * Called with each streamed token of the model's reasoning, when the provider
   * reports it.
   *
   * Reasoning is never part of the conversation — it is not sent back on the
   * next request, because it is not a standard field and most providers reject
   * or ignore it. It exists purely so the user can watch the model work, which
   * is the difference between a five-second pause that looks like a hang and a
   * five-second pause you can read.
   */
  onReasoning?: (text: string) => void
  /**
   * Abort if nothing arrives for this long, in milliseconds.
   *
   * A *stall* timeout, not a total-duration cap: the clock resets on every chunk,
   * so a long answer that keeps streaming is never cut short while a request that
   * has silently died is. This is the distinction that matters for a streamed
   * response — capping total duration would kill a legitimate five-minute
   * generation, and capping nothing kills the agent instead.
   *
   * Without this the agent's request had no timeout at all. A stalled endpoint
   * left the run parked on a promise forever: the status stayed "working", the
   * loop never unwound, and the panel sat on "Working…" with a Stop button that
   * aborted a controller the loop had long since stopped watching. The session
   * was then saved as still running, the background was suspended, and the next
   * start reported it as interrupted — repeatedly, which is the loop this fixes.
   */
  stallMs?: number
}

/**
 * Why a request ended: a stall, or a deliberate stop.
 *
 * The caller's signal and the watchdog's are combined into one, so the *reason*
 * is what distinguishes them — and the difference matters, because telling
 * someone their request stalled when they pressed Stop would be wrong.
 */
function abortReason(signal: AbortSignal): LlmError {
  if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return new LlmError(
      'The endpoint stopped responding.',
      undefined,
      'It accepted the request and then sent nothing for a while. It may be overloaded, or the model may have crashed — try again, or pick a smaller model.',
    )
  }
  return new LlmError('Stopped.')
}

/** Default stall timeout: long enough for a slow local model to start talking. */
const DEFAULT_STALL_MS = 90_000

/**
 * Aborts when `stallMs` passes with no activity.
 *
 * `bump()` restarts the clock and is called for every chunk received, which is
 * what makes this a stall detector rather than a deadline.
 */
function createStallWatch(stallMs: number): { signal: AbortSignal, bump: () => void, stop: () => void } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`No response for ${Math.round(stallMs / 1000)}s`, 'TimeoutError'),
        ),
      stallMs,
    )
  }
  arm()
  return {
    signal: controller.signal,
    bump: arm,
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * One turn of conversation. Streams so the sidebar can show prose as it
 * arrives, and reassembles streamed tool calls — providers split their JSON
 * arguments across arbitrary chunk boundaries.
 *
 * Falls back to a non-streaming request if the endpoint streams badly, which
 * some self-hosted gateways do.
 */
export async function chat(s: Settings, opts: ChatOptions): Promise<ChatResult> {
  if (!s.endpoint.trim()) throw new LlmError('No endpoint configured.', undefined, 'Open Settings and add your model endpoint.')
  if (!s.model.trim()) throw new LlmError('No model configured.', undefined, 'Open Settings and choose a model.')

  const body: Record<string, unknown> = {
    model: s.model,
    messages: opts.messages,
    temperature: s.temperature,
    stream: true,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  /*
   * The caller's signal governs a deliberate stop; the watchdog governs a
   * request that has died on its own. Both have to be able to end the request,
   * so they are combined rather than one replacing the other.
   */
  const stall = createStallWatch(opts.stallMs ?? DEFAULT_STALL_MS)
  const signal = AbortSignal.any([opts.signal, stall.signal])

  try {
    const res = await fetchWithRetry(
      () =>
        fetch(url(s, '/chat/completions'), {
          method: 'POST',
          headers: headers(s),
          body: JSON.stringify(body),
          signal,
        }),
      signal,
    )
    // Headers arrived, so the endpoint is alive; the per-chunk clock takes over.
    stall.bump()

    if (!res.ok) {
      throw describeStatus(res.status, await res.text())
    }

    // A provider that ignores `stream` returns plain JSON. Detect by content
    // type rather than assuming, and handle both.
    const ctype = res.headers.get('content-type') ?? ''
    if (!res.body || !ctype.includes('text/event-stream')) {
      const parsed = parseNonStreaming(await res.json(), opts.onToken, opts.onReasoning)
      stall.stop()
      return parsed
    }

    const streamed = await parseStreaming(
      res.body,
      opts.onToken,
      opts.onReasoning,
      signal,
      stall.bump,
    )
    stall.stop()
    return streamed
  } catch (err) {
    throw describeFailure(err, s)
  } finally {
    stall.stop()
  }
}

async function parseStreaming(
  stream: ReadableStream<Uint8Array>,
  onToken: ((t: string) => void) | undefined,
  onReasoning: ((t: string) => void) | undefined,
  signal: AbortSignal,
  /** Called on every chunk, to restart the stall watchdog. */
  onProgress?: () => void,
): Promise<ChatResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null

  // Tool calls arrive fragmented, keyed by the `index` the provider assigns.
  const partial = new Map<number, { id: string, name: string, args: string }>()

  const consume = (payload: string) => {
    if (payload === '[DONE]') return
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      return // keep-alive comment or a truncated frame; skip it
    }
    if (json?.error) {
      throw new LlmError(
        extractProviderMessage(JSON.stringify(json)) || 'The endpoint reported an error mid-stream.',
      )
    }
    const choice = json?.choices?.[0]
    if (!choice) return

    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = choice.delta ?? choice.message
    if (!delta) return

    const text = typeof delta.content === 'string' ? delta.content : ''
    if (text) {
      content += text
      onToken?.(text)
    }

    /*
     * Reasoning tokens. Providers do not agree on a field name, so all the
     * known spellings are checked:
     *
     *   reasoning_content  DeepSeek, and most gateways fronting it
     *   reasoning_details  OpenRouter's normalised form
     *   reasoning          used by several self-hosted runners
     *   thinking           Anthropic-shaped proxies translating to OpenAI wire
     *
     * This is deliberately kept out of `content`: it is not part of the answer,
     * and it must not be sent back on the next request, because it is not a
     * standard field and providers reject or ignore it. It is surfaced only so
     * the user can watch the model work.
     */
    const thinking =
      delta.reasoning_content ??
      delta.reasoning ??
      delta.thinking ??
      (typeof delta.reasoning_details === 'string' ? delta.reasoning_details : undefined)

    if (typeof thinking === 'string' && thinking) {
      reasoning += thinking
      onReasoning?.(thinking)
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : 0
      const slot = partial.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments
      partial.set(idx, slot)
    }
  }

  /*
   * A read is raced against the abort, rather than relying on the abort
   * propagating to the response body.
   *
   * Aborting the signal passed to `fetch` is *supposed* to error the body
   * stream, and in practice it usually does — but `reader.read()` itself does not
   * observe any signal, so a stall ends up depending on transport behaviour that
   * is neither guaranteed nor uniform. Racing it here makes the watchdog work
   * regardless: if the signal fires, the read stops, whoever is responsible for
   * the underlying connection.
   *
   * Built once, outside the loop. A promise settles once, so there is nothing to
   * rebuild, and building it per read would add an abort listener per chunk.
   */
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(abortReason(signal))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      // Any bytes at all count as progress — including a keep-alive comment,
      // which is exactly what a slow endpoint sends to say it is still there.
      onProgress?.()
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; \r\n\r\n appears in the wild.
      let sep: number
      while ((sep = findFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '')
        for (const line of frame.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (!trimmed.startsWith('data:')) continue
          consume(trimmed.slice(5).trim())
        }
      }
    }
    // Whatever is left after the stream closes.
    const tail = buffer.trim()
    if (tail.startsWith('data:')) consume(tail.slice(5).trim())
  } finally {
    // Release the reader so the connection is not left held open after a stall.
    // Errors here are of no interest: the request is already over.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  const toolCalls: ToolCall[] = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({
      id: v.id || `call_${i}`,
      name: v.name,
      arguments: v.args || '{}',
    }))
    .filter((c) => c.name)

  return { content, toolCalls, finishReason, reasoning }
}

/** Finds the blank-line boundary that ends an SSE frame. */
function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

function parseNonStreaming(
  json: any,
  onToken: ((t: string) => void) | undefined,
  onReasoning: ((t: string) => void) | undefined,
): ChatResult {
  if (json?.error) {
    throw new LlmError(extractProviderMessage(JSON.stringify(json)) || 'The endpoint reported an error.')
  }
  const choice = json?.choices?.[0]
  const msg = choice?.message ?? {}
  const content = typeof msg.content === 'string' ? msg.content : ''
  if (content) onToken?.(content)

  const reasoning =
    (typeof msg.reasoning_content === 'string' && msg.reasoning_content) ||
    (typeof msg.reasoning === 'string' && msg.reasoning) ||
    (typeof msg.thinking === 'string' && msg.thinking) ||
    ''
  if (reasoning) onReasoning?.(reasoning)

  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .map((tc: any, i: number) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}',
    }))
    .filter((c: ToolCall) => c.name)

  return { content, toolCalls, finishReason: choice?.finish_reason ?? null, reasoning }
}

/** Asks the endpoint which models it serves. Not all providers implement it. */
export async function listModels(s: Settings): Promise<string[]> {
  const res = await fetchWithRetry(
    () => fetch(url(s, '/models'), { headers: headers(s), signal: AbortSignal.timeout(15000) }),
    AbortSignal.timeout(15000),
  )
  if (!res.ok) throw describeStatus(res.status, await res.text())
  const json = await res.json()
  const ids: string[] = (json?.data ?? json?.models ?? [])
    .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name))
    .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0)
  return [...new Set(ids)].sort()
}

/**
 * Settings-page "Test connection": one cheap round trip that also proves the
 * model accepts tool calling, which is the thing that actually breaks.
 */
export async function testConnection(s: Settings): Promise<{
  ok: boolean
  message: string
  models?: string[]
  latencyMs?: number
}> {
  const started = Date.now()
  try {
    const result = await chat(
      { ...s, temperature: 0 },
      {
        signal: AbortSignal.timeout(45000),
        messages: [
          { role: 'system', content: 'You are a connection test. Reply by calling the tool.' },
          { role: 'user', content: 'Call the ping tool with value "ok".' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Reports that the connection works.',
              parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
        ],
      },
    )

    const latencyMs = Date.now() - started
    if (!result.toolCalls.length) {
      return {
        ok: false,
        latencyMs,
        message:
          `Reached ${s.model}, but it did not call the tool. ` +
          `WebPilot needs a model that supports function calling — this one may not.`,
      }
    }
    return {
      ok: true,
      latencyMs,
      message: `Connected to ${s.model} in ${latencyMs} ms. Tool calling works.`,
    }
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError(String(err))
    return { ok: false, message: [e.message, e.hint].filter(Boolean).join(' ') }
  }
}

/**
 * A token-bucket limiter. Guards a local model — or a metered free tier — from
 * being hammered by a fast agent loop, which is easy to do by accident.
 */
export class RateLimiter {
  private stamps: number[] = []
  constructor(private perMinute: number) {}

  setLimit(perMinute: number) {
    this.perMinute = perMinute
  }

  async take(signal: AbortSignal): Promise<void> {
    if (this.perMinute <= 0) return
    for (;;) {
      const now = Date.now()
      this.stamps = this.stamps.filter((t) => now - t < 60_000)
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now)
        return
      }
      const oldest = this.stamps[0]
      await sleep(Math.max(250, 60_000 - (now - oldest) + 50), signal)
    }
  }
}