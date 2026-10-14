/**
 * The agent loop, with one session per tab.
 *
 * Sessions are keyed by tab rather than held globally. That is what makes
 * switching tabs feel like switching conversations: each tab has its own
 * transcript, its own step history, and its own run. A task started in one tab
 * keeps going while you look at another, and coming back to it shows it exactly
 * where it was.
 *
 * Because of that, several runs can be in flight at once — one per tab. Each has
 * its own `AbortController`, so stopping one leaves the others alone, and each
 * carries its own conversation history, so a follow-up in one tab cannot be
 * confused by what happened in another.
 *
 * Three things in the loop are load-bearing and non-obvious:
 *
 *  - **The model never sees a raw tool result.** Every result is phrased for it
 *    ("Clicked \"Sign in\".") rather than dumped as JSON, because its next
 *    decision is entirely shaped by how the last outcome is described.
 *
 *  - **A stale page forces a re-read.** Any action that can change the page
 *    invalidates every element reference, and a confidently wrong reference is
 *    worse than an honest "read the page again".
 *
 *  - **Recovery is explicit.** A model that repeats the same call, or fails
 *    repeatedly, is stuck; the loop detects that and tells it to change approach
 *    rather than letting it burn the step budget.
 */

import { ext, loadSettings, type Settings } from '@/shared/settings'
import type { AgentEvent, AgentStatus, ChatMessage, PageNode, Snapshot, Step } from '@/shared/types'
import { chat, LlmError, RateLimiter, type ContentPart, type ToolCall, type WireMessage } from './llm'
import {
  captureAnnotated,
  clearHighlight,
  execOp,
  readPage,
  renderSnapshot,
  setHighlight,
} from './page-bridge'
import { assessRisk, describeAction, isCrossSite, MUTATING_TOOLS, toolsFor } from './tools'
import { clampResult, runScript, type ScriptWorld } from './evaluate'

/* -------------------------------------------------------------------------- */
/*  Session state                                                              */
/* -------------------------------------------------------------------------- */

export type Session = {
  /** The tab this conversation belongs to. */
  tabId: number
  status: AgentStatus
  messages: ChatMessage[]
  steps: Step[]
  question: { id: string, text: string } | null
  approval: { id: string, action: string, reason: string } | null
  /** Text arriving right now. */
  stream: { thinking: string, answer: string }
  /** Completed reasoning and prose, keyed by turn. */
  turns: Record<number, { thinking: string, answer: string }>
  note?: string
}

type Listener = (tabId: number, event: AgentEvent, session: Session) => void

/** Callbacks that render the approval and question prompts in a panel. */
type Asker = {
  /** Resolves true to proceed, false to skip this action. */
  approve(tabId: number, action: string, reason: string): Promise<boolean>
  /** Resolves with the user's answer, or '' if it went unanswered. */
  ask(tabId: number, id: string, question: string): Promise<string>
}

const MAX_CONSECUTIVE_FAILURES = 5
const MAX_REPEATED_CALLS = 3

/* -------------------------------------------------------------------------- */
/*  The agent                                                                  */
/* -------------------------------------------------------------------------- */

export class Agent {
  private controllers = new Map<number, AbortController>()
  private sessions = new Map<number, Session>()
  private stepCounters = new Map<number, number>()
  private turnCounters = new Map<number, number>()
  private listeners = new Set<Listener>()
  private asker: Asker | null = null
  /** Public so the router can retune it when settings change mid-run. */
  readonly rateLimiter = new RateLimiter(120)

  /* ---------------------------------------------------------------------- */
  /*  Sessions                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The conversation for a tab, created empty on first use.
   *
   * Sessions outlive runs: a task that finished is still there to read, and a
   * follow-up continues the same conversation rather than starting over.
   */
  sessionFor(tabId: number): Session {
    let session = this.sessions.get(tabId)
    if (!session) {
      session = {
        tabId,
        status: 'idle',
        messages: [],
        steps: [],
        question: null,
        approval: null,
        stream: { thinking: '', answer: '' },
        turns: {},
      }
      this.sessions.set(tabId, session)
    }
    return session
  }

  get tabIds(): number[] {
    return [...this.sessions.keys()]
  }

  isRunning(tabId: number): boolean {
    const status = this.sessions.get(tabId)?.status
    return status === 'working' || status === 'waiting'
  }

  /**
   * Drops a tab's session.
   *
   * Called when the tab closes. Without it the map would grow for the life of
   * the browser session, holding full transcripts for tabs that no longer exist.
   * Any run in that tab is stopped first — it has nowhere left to act.
   */
  forget(tabId: number): void {
    this.stop(tabId)
    this.sessions.delete(tabId)
    this.stepCounters.delete(tabId)
    this.turnCounters.delete(tabId)
  }

  /* ---------------------------------------------------------------------- */
  /*  Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** The UI that owns the current runs supplies these. */
  setAsker(asker: Asker | null): void {
    this.asker = asker
  }

  private emit(tabId: number, event: AgentEvent): void {
    const session = this.sessionFor(tabId)

    if (event.kind === 'step') session.steps = [...session.steps, event.step].slice(-200)
    if (event.kind === 'message') session.messages = [...session.messages, event.message].slice(-100)
    if (event.kind === 'cleared') {
      session.messages = []
      session.steps = []
    }
    if (event.kind === 'status') {
      session.status = event.status
      session.note = event.note
    }

    for (const fn of this.listeners) {
      try {
        fn(tabId, event, session)
      } catch {
        // A broken listener must not take down the run.
      }
    }
  }

  private setStatus(session: Session, status: AgentStatus, note?: string): void {
    this.emit(session.tabId, { kind: 'status', status, note })
  }

  private addStep(session: Session, step: Omit<Step, 'id' | 'at' | 'turn'>): Step {
    /*
     * Attach whatever the model reasoned on the way to this step. Doing it here
     * rather than at each call site means every step records its own reasoning
     * without the twenty-odd `addStep` calls having to know about it — and a new
     * step kind added later gets the behaviour for free.
     */
    const thinking = step.thinking ?? session.stream.thinking.trim() ?? ''
    const next = (this.stepCounters.get(session.tabId) ?? 0) + 1
    this.stepCounters.set(session.tabId, next)

    const full: Step = {
      ...step,
      turn: this.turnCounters.get(session.tabId) ?? 1,
      thinking: thinking || undefined,
      id: `s${session.tabId}_${next}`,
      at: Date.now(),
    }
    this.emit(session.tabId, { kind: 'step', step: full })
    return full
  }

  private addMessage(session: Session, role: ChatMessage['role'], text: string): ChatMessage {
    const message: ChatMessage = {
      id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      role,
      text,
      at: Date.now(),
    }
    this.emit(session.tabId, { kind: 'message', message })
    return message
  }

  clear(tabId: number): void {
    const session = this.sessionFor(tabId)
    this.emit(tabId, { kind: 'cleared' })
    session.question = null
    session.approval = null
    session.stream = { thinking: '', answer: '' }
    session.turns = {}
    this.setStatus(session, 'idle')
  }

  /**
   * Requests that the run in one tab stop.
   *
   * Only aborts; it deliberately does not clear the controller. `run()` is
   * usually parked in an await and continues executing for a moment after this
   * returns, so nulling the field would make its next `signal` access throw —
   * turning a request to stop into a confusing crash. `run`'s own `finally`
   * clears it, once the loop has actually unwound.
   */
  stop(tabId: number): void {
    this.controllers.get(tabId)?.abort()
  }

  /* ---------------------------------------------------------------------- */
  /*  The loop                                                               */
  /* ---------------------------------------------------------------------- */

  async run(prompt: string, tabId: number): Promise<void> {
    const session = this.sessionFor(tabId)

    if (this.isRunning(tabId)) {
      throw new Error('WebPilot is already working in this tab. Stop it first.')
    }

    const settings = await loadSettings()
    if (!settings.endpoint.trim() || !settings.model.trim()) {
      this.addMessage(
        session,
        'assistant',
        'No model is configured yet. Open Settings and add your endpoint, key and model.',
      )
      this.setStatus(session, 'error', 'Not configured')
      return
    }

    /*
     * Re-check after the await above. Two `agent/run` requests arriving in quick
     * succession would both have passed the first check; the second would then
     * replace the first run's controller, orphaning a run that is still going
     * with no way to stop it.
     */
    if (this.isRunning(tabId)) return

    const abort = new AbortController()
    this.controllers.set(tabId, abort)
    this.rateLimiter.setLimit(settings.rateLimit)

    this.turnCounters.set(tabId, 1)
    this.addMessage(session, 'user', prompt)
    this.setStatus(session, 'working', 'Starting')
    session.question = null
    session.approval = null
    session.stream = { thinking: '', answer: '' }
    session.turns = {}

    /*
     * Carry earlier turns into this one.
     *
     * The transcript persists per tab, so a follow-up like "now book the second
     * one" only makes sense if the model can see what "the second one" referred
     * to. Only the *user's* previous requests and the agent's conclusions are
     * replayed — not its tool calls, which referenced elements on a page that
     * has since changed and would invite reuse of refs that no longer exist.
     */
    const wire: WireMessage[] = [{ role: 'system', content: settings.systemPrompt }]

    const history = priorTurns(session)
    if (history.length) {
      wire.push({
        role: 'user',
        content:
          'Earlier in this session, before the current request, you were asked the following. ' +
          'This is background only — do not act on it again.\n\n' +
          history.join('\n\n'),
      })
    }

    wire.push({ role: 'user', content: prompt })

    // Prime the page so the model's first turn already has something to look at.
    let snapshot = await this.safeRead(tabId)
    if (snapshot) {
      wire.push({
        role: 'user',
        content: await this.pageMessage(
          tabId,
          snapshot,
          'Here is the page the user is looking at.\n\n' +
            renderSnapshot(snapshot) +
            '\n\nBegin the task. Call tools to act; call finish when you are done.',
        ),
      })
    }

    let consecutiveFailures = 0
    const recentCalls: string[] = []

    try {
      for (let step = 0; step < settings.maxSteps; step++) {
        if (abort.signal.aborted) return void this.finishStopped(session)

        /*
         * No step counter in the status.
         *
         * It re-rendered on every turn, so the pill flickered through "Step 1 of
         * 25 … Step 2 of 25 …" the whole time — changing many times a second
         * worth of reading, and saying nothing the transcript did not already
         * show. The step limit still stops the run and is still reported in the
         * message when it is reached; it just is not narrated continuously.
         */
        this.setStatus(session, 'working')
        // A new turn: fresh streaming text, and a new group in the transcript.
        this.turnCounters.set(tabId, (this.turnCounters.get(tabId) ?? 0) + 1)
        session.stream = { thinking: '', answer: '' }

        await this.rateLimiter.take(abort.signal)
        const settingsNow = await loadSettings()

        let reply
        try {
          reply = await chat(settingsNow, {
            messages: wire,
            tools: toolsFor({
              canAsk: Boolean(this.asker),
              allowScripting: settingsNow.allowScripting,
            }),
            signal: abort.signal,
            onToken: (text) => this.streamChunk(session, 'answer', text),
            onReasoning: settingsNow.showThinking
              ? (text) => this.streamChunk(session, 'thinking', text)
              : undefined,
          })
        } catch (err) {
          if (this.isStopped(abort, err)) return void this.finishStopped(session)
          const e = err instanceof LlmError ? err : new LlmError(String(err))
          this.addStep(session, {
            index: step + 1,
            kind: 'error',
            title: e.message,
            detail: e.hint,
            ok: false,
          })
          this.addMessage(session, 'assistant', [e.message, e.hint].filter(Boolean).join('\n\n'))
          this.setStatus(session, 'error', 'Request failed')
          return
        }

        /*
         * Bank this turn's reasoning and prose before the stream is cleared by
         * the step that follows. This is what lets a finished turn show its
         * thinking as an expandable record instead of losing it the moment the
         * live box folds away.
         */
        const turnNo = this.turnCounters.get(tabId) ?? 1
        if (session.stream.thinking.trim() || prose0(reply.content)) {
          session.turns = {
            ...session.turns,
            [turnNo]: {
              thinking: session.stream.thinking.trim(),
              answer: reply.content.trim(),
            },
          }
        }

        const prose = reply.content.trim()

        if (!reply.toolCalls.length) {
          // A model that answers without calling a tool has decided it is done.
          if (prose) {
            this.addMessage(session, 'assistant', prose)
            wire.push({ role: 'assistant', content: prose })
            this.setStatus(session, 'done', 'Finished')
            return
          }
          wire.push({
            role: 'user',
            content:
              'You did not call a tool. If the task is complete, call finish with a summary. ' +
              'Otherwise call a tool to make progress.',
          })
          continue
        }

        // Record the assistant turn so the tool results have something to attach to.
        wire.push({
          role: 'assistant',
          content: reply.content || null,
          tool_calls: reply.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        })

        if (prose) this.addMessage(session, 'assistant', prose)

        let finished = false
        for (const call of reply.toolCalls) {
          const signature = `${call.name}:${call.arguments}`
          recentCalls.push(signature)
          if (recentCalls.length > MAX_REPEATED_CALLS * 2) recentCalls.shift()

          const repeats = recentCalls.filter((s) => s === signature).length
          if (repeats >= MAX_REPEATED_CALLS && call.name !== 'read_page' && call.name !== 'wait') {
            wire.push({
              role: 'tool',
              tool_call_id: call.id,
              content:
                `You have made this exact call ${repeats} times with no change. Something is wrong. ` +
                'Read the page again and try a different approach, or call finish to tell the user what is blocking you.',
            })
            this.addStep(session, {
              index: step + 1,
              kind: 'note',
              title: 'Repeated the same action — steering it elsewhere',
              detail: `${call.name} ×${repeats}`,
              ok: false,
            })
            continue
          }

          const outcome = await this.execute(
            session,
            call,
            tabId,
            settingsNow,
            step + 1,
            snapshot,
            abort,
          )
          wire.push({ role: 'tool', tool_call_id: call.id, content: outcome.content })

          if (outcome.snapshot) snapshot = outcome.snapshot

          if (outcome.kind === 'finished') {
            finished = true
            break
          }
          if (outcome.ok) consecutiveFailures = 0
          else consecutiveFailures++
        }

        if (finished) return

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.addMessage(
            session,
            'assistant',
            `I could not make progress — the last ${consecutiveFailures} actions all failed. ` +
              "Stopping so I don't keep clicking at random. Ask me to try a different approach, or take over from here.",
          )
          this.setStatus(session, 'error', 'Stuck')
          return
        }

        // Re-read after any mutating action so the next turn sees reality.
        const mutated = reply.toolCalls.some(
          (c) => MUTATING_TOOLS.has(c.name) || c.name === 'scroll',
        )
        if (mutated) {
          const fresh = await this.safeRead(tabId)
          if (fresh) {
            snapshot = fresh
            wire.push({
              role: 'user',
              content: await this.pageMessage(
                tabId,
                fresh,
                'Current page state:\n\n' + renderSnapshot(fresh),
              ),
            })
          }
        }
      }

      this.addMessage(
        session,
        'assistant',
        `I stopped after ${settings.maxSteps} actions without finishing. ` +
          'The task may need more steps — you can raise the limit in Settings — or I may be going in circles. ' +
          `Here is where I got to: ${session.steps.slice(-3).map((s) => s.title).join('; ')}`,
      )
      this.setStatus(session, 'error', 'Step limit reached')
    } catch (err) {
      if (this.isStopped(abort, err)) return void this.finishStopped(session)
      const message = err instanceof Error ? err.message : String(err)
      this.addStep(session, { index: 0, kind: 'error', title: message, ok: false })
      this.addMessage(session, 'assistant', `Something went wrong: ${message}`)
      this.setStatus(session, 'error', 'Failed')
    } finally {
      // Only clear if this run still owns the controller — a newer run in the
      // same tab must not have its controller dropped by an older one unwinding.
      if (this.controllers.get(tabId) === abort) this.controllers.delete(tabId)
    }
  }

  private isStopped(abort: AbortController, err: unknown): boolean {
    if (abort.signal.aborted) return true
    return err instanceof LlmError && err.message === 'Stopped.'
  }

  private finishStopped(session: Session): void {
    this.addStep(session, { index: 0, kind: 'note', title: 'Stopped at your request', ok: true })
    this.setStatus(session, 'stopped', 'Stopped')
  }

  /* ---------------------------------------------------------------------- */
  /*  Executing one tool call                                                */
  /* ---------------------------------------------------------------------- */

  private async execute(
    session: Session,
    call: ToolCall,
    tabId: number,
    settings: Settings,
    stepIndex: number,
    snapshot: Snapshot | null,
    abort: AbortController,
  ): Promise<{
    content: string
    ok: boolean
    kind: 'continue' | 'finished'
    snapshot?: Snapshot
  }> {
    const step = { index: stepIndex }

    let args: Record<string, unknown> = {}
    if (call.arguments?.trim()) {
      try {
        args = JSON.parse(call.arguments)
      } catch {
        // Small models emit malformed JSON constantly. Say so in a way that
        // teaches the shape, rather than failing the whole run.
        this.addStep(session, {
          ...step,
          kind: 'error',
          title: `${call.name}: malformed arguments`,
          detail: call.arguments.slice(0, 160),
          ok: false,
        })
        return {
          content:
            `Your arguments were not valid JSON: ${call.arguments.slice(0, 200)}. ` +
            `Call ${call.name} again with a single JSON object.`,
          ok: false,
          kind: 'continue',
        }
      }
    }

    /* -- finish ---------------------------------------------------------- */
    if (call.name === 'finish') {
      const summary = String(args.summary ?? '').trim() || 'Task complete.'
      const success = args.success !== false
      this.addMessage(session, 'assistant', summary)
      this.addStep(session, {
        ...step,
        kind: 'answer',
        title: summary,
        detail: success ? undefined : 'Reported as blocked',
        ok: success,
      })
      this.setStatus(session, success ? 'done' : 'error', success ? 'Finished' : 'Needs you')
      void clearHighlight(tabId).catch(() => {})
      return { content: 'Done.', ok: true, kind: 'finished' }
    }

    /* -- read_page ------------------------------------------------------- */
    if (call.name === 'read_page') {
      const fresh = await this.safeRead(tabId)
      if (!fresh) {
        return {
          content:
            'Could not read the page — it may be loading, or a browser-internal page WebPilot cannot access.',
          ok: false,
          kind: 'continue',
        }
      }
      await clearHighlight(tabId)
      this.addStep(session, {
        ...step,
        kind: 'read',
        title: 'Read the page',
        detail: `${fresh.frames.length} region(s), ${countNodes(fresh)} interactive element(s)`,
        ok: true,
      })
      return { content: renderSnapshot(fresh), ok: true, kind: 'continue', snapshot: fresh }
    }

    /* -- wait ------------------------------------------------------------ */
    if (call.name === 'wait') {
      const ms = Math.min(Math.max(Number(args.ms) || 1000, 100), 10_000)
      await sleep(ms, abort.signal)
      this.addStep(session, { ...step, kind: 'read', title: `Waited ${ms} ms`, ok: true })
      return { content: `Waited ${ms} ms.`, ok: true, kind: 'continue' }
    }

    /* -- scroll ---------------------------------------------------------- */
    if (call.name === 'scroll') {
      const direction = String(args.direction ?? 'down')
      const res = await execOp(tabId, {
        op: 'scroll',
        direction: direction as 'up' | 'down' | 'top' | 'bottom',
        amount: args.amount == null ? undefined : Number(args.amount),
      })
      this.addStep(session, { ...step, kind: 'act', title: `Scrolled ${direction}`, ok: res.ok })
      if (!res.ok) return { content: res.message, ok: false, kind: 'continue' }

      const fresh = await this.safeRead(tabId)
      return {
        content: fresh
          ? `Scrolled ${direction}. The page now shows:\n\n${renderSnapshot(fresh)}`
          : `Scrolled ${direction}.`,
        ok: true,
        kind: 'continue',
        snapshot: fresh ?? undefined,
      }
    }

    /* -- press_key ------------------------------------------------------- */
    if (call.name === 'press_key') {
      const key = String(args.key ?? '')
      if (!key) return { content: 'No key given.', ok: false, kind: 'continue' }
      const res = await execOp(tabId, { op: 'key', key })
      this.addStep(session, { ...step, kind: 'act', title: `Pressed ${key}`, ok: res.ok })
      return { content: res.message, ok: res.ok, kind: 'continue' }
    }

    /* -- evaluate -------------------------------------------------------- */
    if (call.name === 'evaluate') {
      const code = String(args.code ?? '')
      if (!code.trim()) {
        return { content: 'evaluate needs a `code` argument.', ok: false, kind: 'continue' }
      }

      const frameRef = typeof args.ref === 'string' ? args.ref : ''
      const frameId = frameRef ? frameIdOf(frameRef) : 0
      const world: ScriptWorld = args.world === 'MAIN' ? 'MAIN' : 'ISOLATED'

      const started = Date.now()
      const outcome = clampResult(await runScript(tabId, frameId, code, world))

      const parts: string[] = []
      if (outcome.logs) parts.push(outcome.logs)
      if (outcome.ok) parts.push(outcome.value ?? 'undefined')
      else if (outcome.error) parts.push(outcome.error)

      let content = parts.join('\n\n') || 'undefined'
      if (outcome.truncated) {
        content += '\n\n[The result was too large and was cut short. Narrow the question.]'
      }

      this.addStep(session, {
        ...step,
        kind: outcome.ok ? 'act' : 'error',
        title: outcome.ok
          ? `Ran JavaScript${frameId ? ` in frame ${frameId}` : ''}${world === 'MAIN' ? ' (page context)' : ''}`
          : 'JavaScript failed',
        detail: truncate(code.replace(/\s+/g, ' ').trim(), 120),
        args: { code, world, ref: frameRef || undefined },
        result: content.slice(0, 2000),
        ok: outcome.ok,
        durationMs: Date.now() - started,
      })

      if (!outcome.ok) {
        return {
          content: `The code failed: ${outcome.error ?? 'unknown error'}`,
          ok: false,
          kind: 'continue',
        }
      }

      return {
        content:
          `Result:\n${content}\n\n` +
          '(If you changed the page, call read_page before acting — element references may have moved.)',
        ok: true,
        kind: 'continue',
      }
    }

    /* -- ask_user -------------------------------------------------------- */
    if (call.name === 'ask_user') {
      const question = String(args.question ?? '').trim()
      if (!question) {
        return { content: 'ask_user needs a "question" argument.', ok: false, kind: 'continue' }
      }
      if (!this.asker) {
        return {
          content:
            'There is no WebPilot panel open to ask through. Decide for yourself, or call ' +
            'finish and explain what you needed.',
          ok: false,
          kind: 'continue',
        }
      }

      this.addStep(session, { ...step, kind: 'note', title: `Asked you: ${question}`, ok: true })
      this.setStatus(session, 'waiting', 'Waiting for you')

      const id = `q${Date.now().toString(36)}`
      session.question = { id, text: question }
      const answer = await this.asker.ask(tabId, id, question)
      session.question = null
      this.setStatus(session, 'working', 'Working')

      if (!answer.trim()) {
        return {
          content:
            'No answer came back, so the question was dismissed. Proceed with your best ' +
            'judgement, or call finish if you cannot.',
          ok: false,
          kind: 'continue',
        }
      }

      this.addMessage(session, 'user', answer)
      this.addStep(session, { ...step, kind: 'note', title: `You answered: ${answer}`, ok: true })
      return { content: `The user answered: ${answer}`, ok: true, kind: 'continue' }
    }

    /* -- ref-targeted actions -------------------------------------------- */
    const ref = typeof args.ref === 'string' ? args.ref : ''
    if (!ref) {
      return {
        content: `${call.name} needs a "ref" argument — the element reference from the page reading, like "f0:n12".`,
        ok: false,
        kind: 'continue',
      }
    }

    const node: PageNode | null = snapshot ? findNode(snapshot, ref) : null
    const targetName = node?.name

    // A ref from a page state we have already replaced is worth catching here,
    // before it reaches the page and fails there with a vaguer message.
    if (snapshot && !node) {
      this.addStep(session, {
        ...step,
        kind: 'error',
        title: `Unknown element "${ref}"`,
        ok: false,
      })
      return {
        content:
          `There is no element "${ref}" on the current page. ` +
          'Call read_page to get current references, then act on one of those.',
        ok: false,
        kind: 'continue',
      }
    }

    // Approval gate. In `auto` nothing is asked; in `risky` only actions that
    // look irreversible are; in `always` everything is.
    const risk = assessRisk(call.name, args, targetName)
    const shouldAsk =
      settings.approval === 'always' || (settings.approval === 'risky' && risk.risky)

    if (shouldAsk) {
      if (!this.asker) {
        // No UI to ask through — refuse rather than act unapproved. Failing
        // closed is the only safe direction here.
        this.addStep(session, {
          ...step,
          kind: 'note',
          title: 'Approval needed — no panel open',
          ok: false,
        })
        return {
          content:
            `Approval is required for "${describeAction(call.name, args, targetName)}" but no ` +
            'WebPilot panel is open. Open the sidebar or panel and try again.',
          ok: false,
          kind: 'continue',
        }
      }

      const action = describeAction(call.name, args, targetName)
      this.setStatus(session, 'waiting', 'Waiting for you')
      const approved = await this.asker.approve(
        tabId,
        action,
        risk.reason ?? 'Your approval mode asks before every action.',
      )
      this.setStatus(session, 'working', 'Working')

      if (!approved) {
        this.addStep(session, { ...step, kind: 'note', title: `You declined: ${action}`, ok: false })
        return {
          content:
            'The user declined that action. Do not retry it. If there is another way to proceed, try that; otherwise call finish and explain.',
          ok: false,
          kind: 'continue',
        }
      }
    }

    /* -- build and run the operation ------------------------------------- */
    // Box the target so the user can see where it is about to act.
    this.highlight(tabId, ref)

    const before = snapshot?.url ?? ''
    const result = await this.runRefAction(call.name, args, ref, tabId)
    const after = await this.currentUrl(tabId)

    // The frame re-issued its refs as part of performing the action, so adopt
    // them now. A turn can contain several tool calls, and without this the
    // second would be resolved against an id the page has since given to a
    // different element — failing silently, with a ref that still looks valid.
    if (snapshot && result.nodes) {
      snapshot = withFrameNodes(snapshot, frameIdOf(ref), result.nodes)
    }

    if (!result.ok) {
      this.addStep(session, {
        ...step,
        kind: 'error',
        title: result.message,
        detail: result.error ?? (node ? `${node.role} ${JSON.stringify(node.name)}` : undefined),
        args,
        ok: false,
      })
      return { content: `${result.message} Try reading the page again.`, ok: false, kind: 'continue' }
    }

    const navigated = before && after && before !== after
    const leftSite = navigated ? isCrossSite(before, after) : false

    this.addStep(session, {
      ...step,
      kind: navigated ? 'navigate' : 'act',
      title: result.message,
      detail: node
        ? `${node.role} ${JSON.stringify(node.name)}${node.inView ? '' : ' (was off-screen)'}`
        : undefined,
      args,
      result: navigated ? `Navigated to ${after}` : undefined,
      ok: true,
    })

    let content = result.message
    if (navigated) {
      content += `\n\nThe page navigated to ${after}. All previous element references are gone — call read_page before acting.`
      if (leftSite) content += '\nThat is a different site from where the task started.'
    } else if (MUTATING_TOOLS.has(call.name)) {
      content +=
        '\n\nThe page may have changed. Call read_page if the next element you need is not in your last reading.'
    }

    return { content, ok: true, kind: 'continue' }
  }

  /** Maps a tool call onto an operation the page bridge understands. */
  private async runRefAction(
    name: string,
    args: Record<string, unknown>,
    ref: string,
    tabId: number,
  ): Promise<{ ok: boolean, message: string, error?: string, nodes?: PageNode[] }> {
    switch (name) {
      case 'click':
        return execOp(tabId, { op: 'click', ref })
      case 'type':
        return execOp(tabId, {
          op: 'type',
          ref,
          text: String(args.text ?? ''),
          clear: args.clear === undefined ? true : Boolean(args.clear),
          submit: Boolean(args.submit),
        })
      case 'select_option':
        return execOp(tabId, { op: 'select', ref, value: String(args.value ?? '') })
      case 'check':
        return execOp(tabId, { op: 'check', ref, checked: Boolean(args.checked) })
      case 'hover':
        return execOp(tabId, { op: 'hover', ref })
      default:
        return { ok: false, message: `Unknown tool "${name}".` }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Page helpers                                                           */
  /* ---------------------------------------------------------------------- */

  private async safeRead(tabId: number): Promise<Snapshot | null> {
    try {
      return await readPage(tabId)
    } catch {
      return null
    }
  }

  private async currentUrl(tabId: number): Promise<string> {
    try {
      const tab = await ext.tabs.get(tabId)
      return tab.url ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Boxes the element an action is about to touch.
   *
   * Fire-and-forget: this is decoration, and a failure to draw a box must never
   * affect whether the action happens.
   */
  private highlight(tabId: number, ref: string): void {
    void setHighlight(tabId, [ref]).catch(() => {})
  }

  /**
   * Builds the user message that carries the page state, attaching a screenshot
   * when vision is enabled.
   *
   * Falls back to text alone on any failure. A model that was told it would get
   * a picture and did not is fine; a run that dies because a screenshot failed
   * is not.
   */
  private async pageMessage(
    tabId: number,
    snapshot: Snapshot,
    text: string,
  ): Promise<string | ContentPart[]> {
    const shot = await this.screenshot(tabId, snapshot)
    if (!shot) return text
    return [
      { type: 'text', text },
      {
        type: 'text',
        text:
          'The screenshot shows the same page. Interactive elements are outlined and labelled ' +
          'with their reference, so you can use the picture to judge layout while still acting by ref.',
      },
      { type: 'image_url', image_url: { url: shot, detail: 'high' } },
    ]
  }

  /** Attaches a screenshot to the conversation, if vision is on and it works. */
  private async screenshot(tabId: number, snapshot: Snapshot): Promise<string | null> {
    const settings = await loadSettings()
    if (!settings.vision) return null
    const tab = await ext.tabs.get(tabId).catch(() => null)
    if (!tab?.windowId) return null
    return captureAnnotated(tabId, tab.windowId, snapshot.marks, snapshot.viewport)
  }

  /* ---------------------------------------------------------------------- */
  /*  Streaming                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Publishes a chunk of text the model is producing.
   *
   * The session keeps its own running total so that a panel connecting mid-turn
   * receives what has been produced so far, rather than joining a stream already
   * in progress and seeing only the tail of it.
   */
  private streamChunk(session: Session, slot: 'thinking' | 'answer', text: string): void {
    if (!text) return
    session.stream = { ...session.stream, [slot]: session.stream[slot] + text }
    this.emit(session.tabId, { kind: 'stream', stream: { id: slot, text, done: false } })
  }
}

/* -------------------------------------------------------------------------- */
/*  Module helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The user's earlier requests and the agent's earlier conclusions, as plain
 * text, most recent last, capped so a long session cannot crowd out the current
 * task.
 */
function priorTurns(session: Session, limit = 6): string[] {
  const prior = session.messages.slice(0, -1)
  if (!prior.length) return []

  const turns: string[] = []
  for (const message of prior) {
    if (message.role === 'user') turns.push(`User asked: ${truncate(message.text, 400)}`)
    else if (message.role === 'assistant') turns.push(`You answered: ${truncate(message.text, 400)}`)
  }
  return turns.slice(-limit)
}

function countNodes(snapshot: Snapshot): number {
  const walk = (nodes: PageNode[]): number =>
    nodes.reduce((n, node) => n + 1 + (node.children ? walk(node.children) : 0), 0)
  return snapshot.frames.reduce((n, f) => n + walk(f.nodes), 0)
}

/** The frame id encoded in a page-wide ref, defaulting to the top frame. */
function frameIdOf(ref: string): number {
  const m = /^f(\d+):/.exec(ref)
  return m ? Number(m[1]) : 0
}

/**
 * Replaces one frame's element tree in a snapshot, leaving the rest alone.
 *
 * Returns a new snapshot rather than mutating, because the agent may still be
 * holding the old one for the current turn's comparison against `before`.
 */
function withFrameNodes(snapshot: Snapshot, frameId: number, nodes: PageNode[]): Snapshot {
  return {
    ...snapshot,
    frames: snapshot.frames.map((frame) =>
      frame.frameId === frameId ? { ...frame, nodes } : frame,
    ),
  }
}

/**
 * Finds a node by its page-wide ref, across every frame.
 *
 * The ref already encodes the frame, so the frame named by the prefix is checked
 * first — but the search falls through to the others rather than giving up. A
 * ref issued before a page rearranged its frames can legitimately still identify
 * an element that has since moved between them, and finding it is better than
 * telling the model the element does not exist.
 *
 * The `seen` set guards against a cyclic tree. Nothing should produce one — the
 * content script builds the tree by descent — but a cycle here would recurse
 * until the background script died, taking every run with it.
 */
function findNode(snapshot: Snapshot, ref: string): PageNode | null {
  const seen = new Set<PageNode>()

  const search = (nodes: PageNode[]): PageNode | null => {
    for (const node of nodes) {
      if (seen.has(node)) continue
      seen.add(node)
      if (node.id === ref) return node
      if (node.children) {
        const hit = search(node.children)
        if (hit) return hit
      }
    }
    return null
  }

  const preferred = snapshot.frames.find((f) => ref.startsWith(`f${f.frameId}:`))
  const ordered = preferred
    ? [preferred, ...snapshot.frames.filter((f) => f !== preferred)]
    : snapshot.frames

  for (const frame of ordered) {
    const hit = search(frame.nodes)
    if (hit) return hit
  }
  return null
}

/** True when the model produced any prose at all. */
function prose0(content: string | null): boolean {
  return Boolean(content?.trim())
}

function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  return collapsed.length > n ? `${collapsed.slice(0, n - 1)}…` : collapsed
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

export const agent = new Agent()