#!/usr/bin/env node
/**
 * Tests for the LLM client's streaming layer.
 *
 * Providers do not agree on how to stream a tool call. The arguments arrive as
 * fragments across arbitrary chunk boundaries, the index is sometimes present
 * and sometimes not, and the same call can be spread over a dozen deltas. Getting
 * this wrong produces a model that appears to work and then calls a tool with
 * truncated JSON — so it is worth testing against realistic chunk shapes rather
 * than a tidy single-frame stream.
 *
 * The client is exercised through `chat()` with a stubbed `fetch`, which keeps
 * the test on the real code path including retries and error mapping.
 */

import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { report, section, test } from "./harness.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")

const bundle = await build({
  entryPoints: [path.join(repo, "src/background/llm.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  alias: { "@": path.join(repo, "src") },
  logLevel: "silent",
})

// The module imports from @/shared/settings, which reads browser globals at
// import time; stub the minimum it touches.
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } }
globalThis.browser = globalThis.chrome

const mod = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
)
const { chat, LlmError, RateLimiter } = mod

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SETTINGS = {
  endpoint: "https://api.example.test/v1",
  apiKey: "sk-test",
  model: "test-model",
  temperature: 0,
  extraHeaders: "",
  maxSteps: 10,
  approval: "auto",
  vision: false,
  systemPrompt: "",
  rateLimit: 0,
}

/** Builds a Response whose body streams the given chunks verbatim. */
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  })
}

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Runs chat() against a stubbed fetch, capturing what was sent. */
async function withFetch(response, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null })
    return typeof response === "function" ? response() : response
  }
  try {
    const result = await fn(calls)
    return { result, calls }
  } finally {
    globalThis.fetch = original
  }
}

const run = (chunks, opts) =>
  withFetch(sseResponse(chunks), () => chat(SETTINGS, { messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal, ...opts }))

/* -------------------------------------------------------------------------- */
/*  Streaming                                                                  */
/* -------------------------------------------------------------------------- */

section("streaming")

await test("reassembles prose from several deltas", async () => {
  const { result } = await run([
    frame({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
    frame({ choices: [{ delta: { content: ", " }, finish_reason: null }] }),
    frame({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.content, "Hello, world")
  assert.equal(result.finishReason, "stop")
})

await test("calls onToken for each delta as it arrives", async () => {
  const seen = []
  await run(
    [
      frame({ choices: [{ delta: { content: "a" } }] }),
      frame({ choices: [{ delta: { content: "b" } }] }),
      "data: [DONE]\n\n",
    ],
    { onToken: (t) => seen.push(t) },
  )
  assert.deepEqual(seen, ["a", "b"], "tokens should stream, not arrive in one lump")
})

await test("handles a frame split across two chunks", async () => {
  // The realistic case: a chunk boundary lands mid-JSON. A parser that assumes
  // one chunk is one frame loses this call entirely.
  const payload = JSON.stringify({
    choices: [{ delta: { content: "split" }, finish_reason: "stop" }],
  })
  const whole = `data: ${payload}\n\n`
  const cut = Math.floor(whole.length / 2)
  const { result } = await run([whole.slice(0, cut), whole.slice(cut), "data: [DONE]\n\n"])
  assert.equal(result.content, "split")
})

await test("handles CRLF line endings", async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })
  const { result } = await run([`data: ${payload}\r\n\r\n`, "data: [DONE]\r\n\r\n"])
  assert.equal(result.content, "crlf")
})

await test("ignores keep-alive comments and blank lines", async () => {
  const { result } = await run([
    ": keep-alive\n\n",
    "\n",
    frame({ choices: [{ delta: { content: "ok" } }] }),
    ": another\n\n",
    "data: [DONE]\n\n",
  ])
  assert.equal(result.content, "ok")
})

await test("skips a malformed frame without losing the rest", async () => {
  const { result } = await run([
    "data: {not json\n\n",
    frame({ choices: [{ delta: { content: "survived" } }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.content, "survived")
})

await test("handles a stream with no [DONE] sentinel", async () => {
  // Not every provider sends one; the loop must finish when the body closes.
  const { result } = await run([
    frame({ choices: [{ delta: { content: "no sentinel" }, finish_reason: "stop" }] }),
  ])
  assert.equal(result.content, "no sentinel")
})

/* -------------------------------------------------------------------------- */
/*  Tool calls                                                                 */
/* -------------------------------------------------------------------------- */

section("tool calls")

await test("reassembles a tool call split across deltas", async () => {
  // This is how OpenAI actually streams arguments: the name in one delta, then
  // the JSON in fragments, with the id only on the first.
  const { result } = await run([
    frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "click", arguments: "" } }],
          },
        },
      ],
    }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"re' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'f":"f0:n1"}' } }] } }] }),
    frame({ choices: [{ finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ])

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, "click")
  assert.equal(result.toolCalls[0].id, "call_abc")
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { ref: "f0:n1" })
})

await test("keeps parallel tool calls in order even when interleaved", async () => {
  const { result } = await run([
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "click", arguments: "" } },
              { index: 1, id: "c1", function: { name: "type", arguments: "" } },
            ],
          },
        },
      ],
    }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"ref":"a"' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ref":"b"}' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ',"text":"x"}' } }] } }] }),
    "data: [DONE]\n\n",
  ])

  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolCalls[0].id, "c0")
  assert.equal(result.toolCalls[1].id, "c1")
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { ref: "b" })
  assert.deepEqual(JSON.parse(result.toolCalls[1].arguments), { ref: "a", text: "x" })
})

await test("handles a tool call with no index field", async () => {
  // Some gateways omit `index`; the client assumes 0 rather than dropping it.
  const { result } = await run([
    frame({
      choices: [
        { delta: { tool_calls: [{ id: "c1", function: { name: "read_page", arguments: "{}" } }] } },
      ],
    }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, "read_page")
})

await test("mints an id when the provider omits one", async () => {
  const { result } = await run([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "wait", arguments: '{"ms":1}' } }] } }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.toolCalls.length, 1)
  assert.ok(result.toolCalls[0].id, "a tool call without an id would break the reply pairing")
})

await test("drops a tool call that never got a name", async () => {
  const { result } = await run([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.toolCalls.length, 0, "a nameless call cannot be dispatched")
})

await test("sends tool schemas and asks for auto choice", async () => {
  const tools = [{ type: "function", function: { name: "x", description: "", parameters: {} } }]
  const { calls } = await run(
    [frame({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"],
    { tools },
  )
  assert.deepEqual(calls[0].body.tools, tools)
  assert.equal(calls[0].body.tool_choice, "auto")
  assert.equal(calls[0].body.stream, true)
})

section("reasoning")

await test("captures reasoning from any of the field names in use", async () => {
  /*
   * Providers do not agree on what to call this. All the known spellings are
   * checked, and the ones that actually appear in the wild are what this covers:
   * `reasoning_content` from DeepSeek and most gateways fronting it,
   * `reasoning` from several self-hosted runners, and OpenRouter's normalised
   * `reasoning_details`.
   */
  for (const field of ["reasoning_content", "reasoning", "reasoning_details", "thinking"]) {
    const { result } = await run([
      frame({ choices: [{ delta: { [field]: "step one " } }] }),
      frame({ choices: [{ delta: { [field]: "step two" } }] }),
      frame({ choices: [{ delta: { content: "the answer" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ])
    assert.equal(result.reasoning, "step one step two", `field \`${field}\` was not captured`)
    assert.equal(result.content, "the answer", "reasoning leaked into the answer")
  }
})

await test("streams reasoning as it arrives", async () => {
  const seen = []
  await run(
    [
      frame({ choices: [{ delta: { reasoning_content: "a" } }] }),
      frame({ choices: [{ delta: { reasoning_content: "b" } }] }),
      frame({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ],
    { onReasoning: (t) => seen.push(t) },
  )
  assert.deepEqual(seen, ["a", "b"], "reasoning should stream, not arrive at the end")
})

await test("keeps reasoning out of the answer text", async () => {
  // The two must not be concatenated: reasoning is not sent back on the next
  // request, so anything that leaks into `content` would be replayed to the
  // model as if it had said it.
  const { result } = await run([
    frame({ choices: [{ delta: { reasoning_content: "hmm, which button?" } }] }),
    frame({ choices: [{ delta: { content: 'I will click it.' }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.content, "I will click it.")
  assert.ok(!result.content.includes("hmm"), "reasoning was folded into the answer")
})

await test("a model with no reasoning reports none", async () => {
  const { result } = await run([
    frame({ choices: [{ delta: { content: "just an answer" }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.reasoning, "")
})

await test("reasoning does not become a phantom tool call", async () => {
  // Reasoning arrives in the same delta object as tool calls for some models, so
  // it is worth pinning that the two are read independently.
  const { result } = await run([
    frame({
      choices: [
        {
          delta: {
            reasoning_content: "I should read the page first.",
            tool_calls: [{ index: 0, id: "c1", function: { name: "read_page", arguments: "{}" } }],
          },
        },
      ],
    }),
    "data: [DONE]\n\n",
  ])
  assert.equal(result.reasoning, "I should read the page first.")
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, "read_page")
})

/* -------------------------------------------------------------------------- */
/*  Non-streaming providers                                                    */
/* -------------------------------------------------------------------------- */

section("non-streaming")

await test("handles a provider that ignores stream=true", async () => {
  // Some self-hosted gateways return plain JSON regardless. Detected by content
  // type rather than assumed.
  const body = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "thinking",
          tool_calls: [{ id: "c1", function: { name: "click", arguments: '{"ref":"f0:n2"}' } }],
        },
      },
    ],
  }
  const { result } = await withFetch(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    () => chat(SETTINGS, { messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal }),
  )
  assert.equal(result.content, "thinking")
  assert.equal(result.toolCalls[0].name, "click")
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { ref: "f0:n2" })
})

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

section("errors")

await test("explains a 401 in terms of the key", async () => {
  const { result } = await withFetch(
    new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    () => chat(SETTINGS, { messages: [], signal: new AbortController().signal }).catch((e) => e),
  ).then((r) => r)
  assert.ok(result instanceof LlmError)
  assert.match(result.message, /rejected the API key/i)
  assert.match(result.hint ?? "", /Invalid API key/, "the provider's own message was not surfaced")
})

await test("explains a 404 in terms of the base URL", async () => {
  const { result } = await withFetch(
    new Response("Not Found", { status: 404 }),
    () => chat(SETTINGS, { messages: [], signal: new AbortController().signal }).catch((e) => e),
  ).then((r) => r)
  assert.match(result.message, /404/)
  assert.match(result.hint ?? "", /\/v1/, "the fix should name the likely cause")
})

await test("explains a 400 in terms of tool calling", async () => {
  const { result } = await withFetch(
    new Response(JSON.stringify({ error: { message: "tools not supported" } }), { status: 400 }),
    () => chat(SETTINGS, { messages: [], signal: new AbortController().signal }).catch((e) => e),
  ).then((r) => r)
  assert.match(result.hint ?? "", /tool calling/i)
})

await test("names the cause for a network failure", async () => {
  const { result } = await withFetch(
    () => {
      throw new TypeError("Failed to fetch")
    },
    () => chat(SETTINGS, { messages: [], signal: new AbortController().signal }).catch((e) => e),
  ).then((r) => r)
  assert.match(result.message, /Could not reach/i)
  assert.ok(result.hint, "a bare 'failed to fetch' is not actionable")
})

await test("mentions OLLAMA_ORIGINS when a local server is unreachable", async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => {
    throw new TypeError("Failed to fetch")
  }
  const err = await chat(
    { ...SETTINGS, endpoint: "http://localhost:11434/v1" },
    { messages: [], signal: new AbortController().signal },
  ).catch((e) => e)
  globalThis.fetch = original
  assert.match(err.hint ?? "", /OLLAMA_ORIGINS/, "the local-server hint should be specific")
})

await test("does not retry a 401", async () => {
  let attempts = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    attempts++
    return new Response("nope", { status: 401 })
  }
  await chat(SETTINGS, { messages: [], signal: new AbortController().signal }).catch(() => {})
  globalThis.fetch = original
  assert.equal(attempts, 1, "a bad key will not fix itself; retrying just wastes time")
})

await test("reports a mid-stream error frame", async () => {
  const { result } = await run([
    frame({ choices: [{ delta: { content: "partial" } }] }),
    frame({ error: { message: "upstream exploded" } }),
  ]).catch((e) => ({ result: e }))
  assert.ok(result instanceof LlmError, `expected an LlmError, got ${result}`)
  assert.match(result.message, /upstream exploded/)
})

/* -------------------------------------------------------------------------- */
/*  Stalls                                                                     */
/* -------------------------------------------------------------------------- */

section("stalls")

await test("a request that never answers is abandoned", async () => {
  /*
   * The failure this guards: the agent's own request had no timeout at all, so a
   * stalled endpoint left the run parked forever — status stuck on "working", a
   * Stop button that aborted a controller nothing was watching, and the session
   * saved as still running. Every restart then reported it as interrupted.
   *
   * The body is never written to and never closed, which is what a silently dead
   * connection looks like.
   */
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const stream = new ReadableStream({ start() {} }) // never enqueues, never closes
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  const started = Date.now()
  const err = await chat(SETTINGS, {
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    stallMs: 120,
  })
    .then(() => null)
    .catch((e) => e)
  globalThis.fetch = original

  assert.ok(err instanceof LlmError, `expected an error, got ${err}`)
  assert.match(err.message, /stopped responding/i, `unhelpful message: ${err.message}`)
  assert.ok(Date.now() - started < 3000, "the stall was not detected promptly")
})

await test("a slow but live stream is not cut short", async () => {
  /*
   * The distinction that makes this a stall timeout rather than a deadline: the
   * clock resets on every chunk. A model that takes ten seconds to answer but is
   * clearly still talking must survive a timeout far shorter than the total.
   */
  const encoder = new TextEncoder()
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      async start(controller) {
        // Ten chunks, each well inside the stall window, but far longer in total.
        for (let i = 0; i < 10; i++) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: String(i) } }] })}\n\n`))
          await new Promise((r) => setTimeout(r, 60))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  const result = await chat(SETTINGS, {
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    stallMs: 200, // total elapsed is ~600ms, well past this
  }).catch((e) => e)
  globalThis.fetch = original

  assert.ok(!(result instanceof Error), `a live stream was cut short: ${result?.message}`)
  assert.equal(result.content, "0123456789")
})

await test("stopping is still reported as a stop, not a stall", async () => {
  // The two share one signal, so the reason has to be what distinguishes them —
  // telling someone their request stalled when they pressed Stop would be wrong.
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const stream = new ReadableStream({ start() {} })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 40)
  const err = await chat(SETTINGS, {
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
    stallMs: 60_000,
  })
    .then(() => null)
    .catch((e) => e)
  globalThis.fetch = original

  assert.match(err?.message ?? "", /Stopped/i, `expected a stop, got: ${err?.message}`)
})

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

section("rate limiting")

await test("a limiter with a zero limit never waits", async () => {
  const limiter = new RateLimiter(0)
  const started = Date.now()
  for (let i = 0; i < 50; i++) await limiter.take(new AbortController().signal)
  assert.ok(Date.now() - started < 100, "limit 0 should mean unlimited")
})

await test("an aborted wait rejects rather than hanging", async () => {
  const limiter = new RateLimiter(1)
  const signal = new AbortController().signal
  await limiter.take(signal) // consumes the single slot

  const controller = new AbortController()
  const pending = limiter.take(controller.signal)
  controller.abort()
  await assert.rejects(pending, /Stopped/)
})

report()