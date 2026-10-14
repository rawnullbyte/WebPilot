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
import { captureAnnotated, execOp, readPage, renderSnapshot } from './page-bridge'
import { assessRisk, describeAction, isCrossSite, MUTATING_TOOLS, toolsFor } from './tools'
import { clampResult, runScript, type ScriptWorld } from './evaluate'
import { loadSessions, saveSessions, type StoredSession } from './sessions-store'

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
  /**
   * Messages waiting to be run, in order.
   *
   * Held on the session so a queue survives both a background restart and a
   * navigation — the two things most likely to be happening while a long task
   * runs and someone is typing their next request.
   */
  queue: string[]
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
  /*  Persistence                                                            */
  /* ---------------------------------------------------------------------- */

  private restoring: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveInFlight: Promise<void> = Promise.resolve()

  /**
   * Restores stored sessions, once per background lifetime.
   *
   * Every entry point awaits this before touching a session, so a caller can
   * never observe a half-restored state — which would look identical to the bug
   * this exists to fix.
   */
  ready(): Promise<void> {
    if (!this.restoring) {
      this.restoring = (async () => {
        for (const stored of await loadSessions()) {
          /*
           * A stored "working" or "waiting" must never be restored as such.
           *
           * Those two statuses describe a *live* run: a controller that can be
           * aborted, a model request in flight, a prompt awaiting an answer. None
           * of that survives a restart, so restoring the status alone produces a
           * session that claims to be running and is not. The consequences are
           * all bad and all silent: `isRunning` stays true so every new prompt is
           * queued behind a run that will never finish; `stop()` aborts a
           * controller that is not there, so the Stop button does nothing; and
           * the panel shows "Working…" with nothing streaming, indefinitely.
           *
           * The run was interrupted. Say so, and leave the session in a state
           * the user can act from.
           */
          const interrupted = stored.status === 'working' || stored.status === 'waiting'

          /*
           * One notice, not one per restart.
           *
           * A run that stalls is saved as still running, so every start reports
           * it as interrupted and appends another notice — and each notice is
           * persisted, so they stack up and the transcript fills with the same
           * line repeated. If the last thing already says the session was
           * interrupted, say nothing more; the state is unchanged and so is the
           * message.
           */
          const alreadyNoted =
            stored.steps.length > 0 &&
            /interrupted/i.test(stored.steps[stored.steps.length - 1].title)

          const steps =
            interrupted && !alreadyNoted
              ? [
                  ...stored.steps,
                  {
                    id: `s${stored.tabId}_interrupted_${Date.now()}`,
                    turn: 0,
                    index: 0,
                    at: Date.now(),
                    kind: 'error' as const,
                    title: 'Interrupted — WebPilot was restarted mid-task',
                    detail:
                      'Nothing is running now. Send a message to continue, or start over.',
                    ok: false,
                  },
                ]
              : stored.steps

          this.sessions.set(stored.tabId, {
            tabId: stored.tabId,
            status: interrupted ? 'error' : stored.status,
            messages: stored.messages,
            steps,
            turns: stored.turns,
            // Queued prompts are kept: the user asked for them, and they are
            // visible with a way to remove each, so keeping them costs nothing.
            // They are not started automatically — resuming automation the
            // moment the browser comes back up would be a surprise, and the run
            // would have no panel to report to or ask questions through.
            queue: stored.queue,
            question: null,
            approval: null,
            stream: { thinking: '', answer: '' },
            note: interrupted ? 'Interrupted' : stored.note,
          })
        }
      })()
    }
    return this.restoring
  }

  /** The serialisable view of every session. */
  private snapshot(): StoredSession[] {
    return [...this.sessions.values()].map((session) => ({
      tabId: session.tabId,
      status: session.status,
      messages: session.messages,
      steps: session.steps,
      turns: session.turns,
      queue: session.queue,
      note: session.note,
    }))
  }

  /**
   * Queues a save, coalescing bursts.
   *
   * Streaming produces an event per token; writing on each would be hundreds of
   * storage round trips per turn. A short debounce collapses them into one, and
   * the trailing write is what guarantees the *final* state lands — the one that
   * matters for a restart.
   */
  private persist(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      // Serialised through a single chain so two writes cannot interleave and
      // leave the older one last.
      this.saveInFlight = this.saveInFlight.then(() => saveSessions(this.snapshot()))
    }, 400)
  }

  /** Writes immediately. Used when the background is about to be unloaded. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveInFlight = this.saveInFlight.then(() => saveSessions(this.snapshot()))
    await this.saveInFlight
  }

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
        queue: [],
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

  /** How many prompts are waiting in a tab. */
  queuedCount(tabId: number): number {
    return this.sessions.get(tabId)?.queue.length ?? 0
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

    // Every mutation is written out, so a background restart cannot lose it.
    this.persist()

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

    /*
     * Drop anything queued. "Stop" means stop — leaving prompts to fire
     * afterwards would make the button appear not to have worked, which is a
     * nastier surprise than losing a queue you can retype.
     */
    const session = this.sessions.get(tabId)
    if (session?.queue.length) {
      session.queue = []
      this.emitQueue(session)
    }

    /*
     * Force the status to a terminal one, unconditionally.
     *
     * A stop that does not stop is the worst failure this class can have: the
     * agent looks busy, nothing is happening, and the one control offered for it
     * does nothing. If there was no live run to abort — an interrupted session,
     * or a controller lost some other way — the abort above silently did
     * nothing, so the status is cleared here instead of being left to whatever
     * set it. Only a status that claims a run is in progress is cleared; a
     * finished session keeps its outcome.
     */
    if (session && (session.status === 'working' || session.status === 'waiting')) {
      session.question = null
      session.approval = null
      session.stream = { thinking: '', answer: '' }
      this.emit(tabId, { kind: 'status', status: 'stopped', note: 'Stopped' })
    } else if (session) {
      this.persist()
    }

    this.draining.delete(tabId)
  }

  /* ---------------------------------------------------------------------- */
  /*  The loop                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts a task, or queues it if one is already running.
   *
   * Queueing rather than refusing is the difference between a request being
   * captured and it being lost: the useful moment to type the next thing is
   * while the current thing is still going, and being told to wait means
   * remembering to come back. Queued prompts run in order, as soon as the
   * current one finishes.
   */
  async run(prompt: string, tabId: number): Promise<void> {
    await this.ready()
    const session = this.sessionFor(tabId)

    if (this.isRunning(tabId)) {
      this.enqueue(session, prompt)
      return
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
     * Re-check after the awaits above. Two `agent/run` requests arriving in quick
     * succession both pass the first check; without this the second would replace
     * the first run's controller, orphaning a run that is still going with no way
     * to stop it. The second request is queued instead.
     */
    if (this.isRunning(tabId)) {
      this.enqueue(session, prompt)
      return
    }

    const abort = new AbortController()
    this.controllers.set(tabId, abort)
    this.rateLimiter.setLimit(settings.rateLimit)
    this.draining.add(tabId)

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
      /*
       * No step limit.
       *
       * The loop runs until the model calls `finish`, or the user stops it. A cap
       * was the wrong guard: a long task — paging through results, filling a
       * large form — legitimately takes many actions, and being cut off part-way
       * through one is worse than the thing the cap was protecting against. The
       * failure modes that a cap would have caught are already handled more
       * precisely by the ones that remain:
       *
       *  - going in circles: the repeat detector below catches the same call made
       *    three times over, which is the actual shape of being stuck;
       *  - cascading breakage: `consecutiveFailures` stops after five failures in
       *    a row, which is the actual shape of losing the thread;
       *  - and cost: Stop is always available, and the cost of a runaway loop is
       *    visible in the transcript as it happens rather than discovered at a
       *    hard boundary some time after it went wrong.
       *
       * `step` is still counted, for the repeat detector's step numbering.
       */
      for (let step = 0; ; step++) {
        if (abort.signal.aborted) return void this.finishStopped(session)

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

      /*
       * Unreachable by design: the loop above only exits by returning, from
       * `finish`, from a stop, or by throwing. Kept as a safety net so a future
       * edit that adds a `break` cannot fall out of the run silently, leaving the
       * session stuck on "working".
       */
      this.setStatus(session, 'done', 'Finished')
    } catch (err) {
      if (this.isStopped(abort, err)) return void this.finishStopped(session)
      const message = err instanceof Error ? err.message : String(err)
      this.addStep(session, { index: 0, kind: 'error', title: message, ok: false })
      this.addMessage(session, 'assistant', `Something went wrong: ${message}`)
      this.setStatus(session, 'error', 'Failed')
    } finally {
      // Only clear if this run still owns the controller — a newer run in the
      // same tab must not have its controller dropped by an older one unwinding.
      if (this.controllers.get(tabId) === abort) {
        this.controllers.delete(tabId)
        this.draining.delete(tabId)
        // Whatever was queued while this ran goes next, in order.
        this.drain(tabId)
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Queue                                                                  */
  /* ---------------------------------------------------------------------- */

  private draining = new Set<number>()

  /**
   * Adds a prompt to the tab's queue.
   *
   * Recorded as a user message straight away, so the transcript shows what you
   * asked and when — a queue that is invisible until it starts is a queue you
   * cannot tell you are in. It is marked pending, and the mark is cleared when
   * the prompt actually becomes the run.
   */
  private enqueue(session: Session, prompt: string): void {
    session.queue = [...session.queue, prompt]
    this.emitQueue(session)
    this.addMessage(session, 'user', prompt)
    this.addStep(session, {
      index: 0,
      kind: 'note',
      title: 'Queued — waiting for the current task to finish',
      detail: truncate(prompt, 120),
      ok: true,
    })
  }

  /** Removes a queued prompt, if it has not started yet. */
  unqueue(tabId: number, prompt: string): boolean {
    const session = this.sessionFor(tabId)
    const at = session.queue.indexOf(prompt)
    if (at === -1) return false

    session.queue = session.queue.filter((_, i) => i !== at)
    // The panel needs the new queue, not just a note that it changed.
    this.emitQueue(session)
    this.addStep(session, {
      index: 0,
      kind: 'note',
      title: 'Removed from the queue',
      detail: truncate(prompt, 120),
      ok: false,
    })
    return true
  }

  /** Publishes the current queue to every interested panel. */
  private emitQueue(session: Session): void {
    this.emit(session.tabId, { kind: 'queue', queue: [...session.queue] })
  }

  /**
   * Starts the next queued prompt, if the tab is free.
   *
   * The `draining` flag stops two runs starting at once when a finish and a new
   * enqueue land in the same tick — which is the common case, since finishing is
   * what frees the tab.
   */
  private drain(tabId: number): void {
    if (this.draining.has(tabId) || this.isRunning(tabId)) return
    const session = this.sessionFor(tabId)
    const next = session.queue[0]
    if (next === undefined) return

    session.queue = session.queue.slice(1)
    this.emitQueue(session)
    this.draining.add(tabId)

    // `run` clears the flag itself once it unwinds.
    void this.run(next, tabId).catch((err) => {
      this.draining.delete(tabId)
      console.error('[WebPilot] queued run failed', err)
    })
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
      /*
       * Raced against the abort. Without this, Stop during a question would do
       * nothing visible: the loop is parked on the promise and would not notice
       * until the five-minute prompt timeout, which is indistinguishable from
       * being stuck.
       */
      const answer = await raceAbort(this.asker.ask(tabId, id, question), abort)
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

      /*
       * Clear the field before recording the answer. The panel derives its prompt
       * from the session, so leaving this set until the next turn means the
       * answered question sits above the composer while the transcript below
       * already says it was answered — and its Send button posts to a prompt id
       * that no longer exists, which now reports an error rather than failing
       * silently.
       */
      session.question = null
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

    /*
     * A ref that does not resolve is the single most common way the agent gets
     * stuck, so the answer has to be specific rather than "try again".
     *
     * Three different causes look identical from here, and telling them apart is
     * the whole point of this branch:
     *
     *  - The ref names a frame that is not in the reading at all. Usually an
     *    iframe whose `src` is empty or which loads later than the read; the model
     *    cannot reach into it because nothing was ever read from it. Retrying the
     *    same ref will never work, and saying "call read_page" invites exactly
     *    that.
     *
     *  - The ref names a frame we did read, but not that node. The element is
     *    genuinely gone or was renumbered.
     *
     *  - There is no reading yet.
     *
     * Left to guess, a model responds to a bare "unknown element" by scrolling and
     * pressing Tab — which is what this looked like in practice: a transcript of
     * waits and key presses against refs that were never going to resolve.
     */
    if (snapshot && !node) {
      const frameId = frameIdOf(ref)
      const knownFrame = snapshot.frames.some((f) => f.frameId === frameId)

      const diagnosis = !knownFrame
        ? `That reference points at frame ${frameId}, which is not part of the current reading. ` +
          'It is probably an embedded frame (an iframe) that had no content when the page was read — ' +
          'often because its source is still loading or empty. ' +
          'Do not retry it. Call read_page to see which frames are readable now, and if it is still ' +
          'missing, the content may not be reachable: tell the user what you cannot see rather than ' +
          'working around it.'
        : `Reference ${JSON.stringify(ref)} is not in the current reading of frame ${frameId}, ` +
          'which suggests the page changed since it was read. Call read_page and act on a reference ' +
          'from that.'

      this.addStep(session, {
        ...step,
        kind: 'error',
        title: !knownFrame ? `Frame ${frameId} is not readable` : `Unknown element "${ref}"`,
        detail: !knownFrame
          ? 'The reference targets a frame that was not part of the reading'
          : undefined,
        ok: false,
      })
      return { content: diagnosis, ok: false, kind: 'continue' }
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
      // Raced against the abort, for the same reason as the question above.
      const approved = await raceAbort(
        this.asker.approve(
          tabId,
          action,
          risk.reason ?? 'Your approval mode asks before every action.',
        ),
        abort,
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

/**
 * Resolves with `promise`, or rejects as soon as `abort` fires.
 *
 * Used for the waits that are not naturally abort-aware: an approval prompt, a
 * question. Those are parked on a promise settled by a panel, so a stop would
 * otherwise go unnoticed until the prompt timed out — minutes of an agent that
 * looks stuck and ignores the button meant to unstick it.
 */
function raceAbort<T>(promise: Promise<T>, abort: AbortController): Promise<T> {
  if (abort.signal.aborted) return Promise.reject(new LlmError('Stopped.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmError('Stopped.'))
    abort.signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        abort.signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        abort.signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
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