/**
 * Session persistence.
 *
 * An MV3 background script is an *event page*: Firefox shuts it down when it
 * goes idle and starts it again on the next event. Everything the agent holds in
 * memory goes with it — the transcripts, the step history, the queue.
 *
 * That is the mechanism behind a bug that looked like the UI misbehaving: a task
 * runs, the background is torn down, the panel's port drops, it reconnects and
 * gets handed a brand-new empty session. From the outside the chat simply resets
 * to a fresh one mid-task, with the run apparently still going. Nothing in the
 * panel could have prevented it, because the state it was showing no longer
 * existed anywhere.
 *
 * A manifest key cannot stop an event page being unloaded, so the fix is to make
 * the state survive: every mutation is written out, and a fresh background starts
 * by reading it back. A restart then looks like nothing happened.
 *
 * `storage.local` rather than `storage.session`: the transcripts are small, and
 * bringing a conversation back after a browser restart is a feature rather than a
 * problem. Writes are debounced and capped, since this is the one thing here that
 * grows without bound.
 */

import { ext } from '@/shared/settings'
import type { AgentStatus, ChatMessage, Step } from '@/shared/types'

/** Everything about a session that is worth keeping. */
export type StoredSession = {
  tabId: number
  status: AgentStatus
  messages: ChatMessage[]
  steps: Step[]
  /** Completed reasoning, keyed by turn. */
  turns: Record<number, { thinking: string, answer: string }>
  /** Messages waiting to run, in order. */
  queue: string[]
  note?: string
}

const KEY = 'webpilot.sessions'

/** Most tabs kept at once. Beyond this the oldest are dropped. */
const MAX_TABS = 20

/** Rough ceiling on the serialised payload, well under the 5 MB local quota. */
const MAX_CHARS = 400_000

/** Reasoning is the bulkiest part and the least useful to restore. Truncate it. */
const MAX_THINKING_CHARS = 4_000

/**
 * Reads the stored sessions back.
 *
 * Never throws: a corrupt or unreadable store must leave the extension working
 * with an empty state rather than failing to start at all. There is nothing
 * useful to do with a bad value except ignore it.
 */
export async function loadSessions(): Promise<StoredSession[]> {
  try {
    const stored = await ext.storage.local.get(KEY)
    const raw = stored?.[KEY]
    if (!raw || typeof raw !== 'object') return []

    const entries = Array.isArray(raw) ? raw : Object.values(raw)
    const out: StoredSession[] = []

    for (const entry of entries) {
      const session = entry as Partial<StoredSession> | null
      if (!session || typeof session.tabId !== 'number') continue
      out.push({
        tabId: session.tabId,
        status: session.status ?? 'idle',
        messages: Array.isArray(session.messages) ? session.messages : [],
        steps: Array.isArray(session.steps) ? session.steps : [],
        turns: session.turns && typeof session.turns === 'object' ? session.turns : {},
        queue: Array.isArray(session.queue) ? session.queue.filter((q) => typeof q === 'string') : [],
        note: typeof session.note === 'string' ? session.note : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Writes the sessions out.
 *
 * Trims before writing rather than after reading, so what is on disk is always
 * already within the cap and a quota error cannot be caused by a single runaway
 * transcript. A failed write is logged and dropped: losing the most recent
 * presentation state is not worth interrupting the run that produced it.
 */
export async function saveSessions(sessions: StoredSession[]): Promise<void> {
  try {
    const trimmed = trim(sessions)
    await ext.storage.local.set({ [KEY]: trimmed })
  } catch (err) {
    console.warn('[WebPilot] could not save session state', err)
  }
}

/** Drops the least valuable content until the payload fits. */
function trim(sessions: StoredSession[]): StoredSession[] {
  // Most recently active first — a session's last step carries its timestamp.
  const ranked = [...sessions].sort((a, b) => lastActivity(b) - lastActivity(a)).slice(0, MAX_TABS)

  const shrink = (list: StoredSession[], thinkingLimit: number, stepLimit: number): StoredSession[] =>
    list.map((session) => ({
      ...session,
      steps: session.steps.slice(-stepLimit).map((step) =>
        step.thinking && step.thinking.length > thinkingLimit
          ? { ...step, thinking: `${step.thinking.slice(0, thinkingLimit)}…` }
          : step,
      ),
      turns: Object.fromEntries(
        Object.entries(session.turns).map(([turn, value]) => [
          turn,
          {
            thinking:
              value.thinking.length > thinkingLimit
                ? `${value.thinking.slice(0, thinkingLimit)}…`
                : value.thinking,
            answer: value.answer,
          },
        ]),
      ),
    }))

  // Progressively harsher, so a normal-sized store is written untouched.
  for (const [thinkingLimit, stepLimit] of [
    [MAX_THINKING_CHARS, 200],
    [1_000, 100],
    [400, 40],
    [0, 10],
  ] as const) {
    const candidate = shrink(ranked, thinkingLimit, stepLimit)
    if (JSON.stringify(candidate).length <= MAX_CHARS) return candidate
  }

  // Still too big: keep the messages only, which are what a reader needs.
  return ranked.slice(0, 5).map((session) => ({
    ...session,
    steps: session.steps.slice(-10),
    turns: {},
  }))
}

function lastActivity(session: StoredSession): number {
  const lastStep = session.steps[session.steps.length - 1]?.at ?? 0
  const lastMessage = session.messages[session.messages.length - 1]?.at ?? 0
  return Math.max(lastStep, lastMessage)
}

/** Removes stored sessions for tabs that no longer exist. */
export async function pruneSessions(liveTabIds: Set<number>): Promise<void> {
  const stored = await loadSessions()
  const kept = stored.filter((s) => liveTabIds.has(s.tabId))
  if (kept.length !== stored.length) await saveSessions(kept)
}

/** Exposed for the settings UI's "forget everything" affordance. */
export async function clearStoredSessions(): Promise<void> {
  try {
    await ext.storage.local.remove(KEY)
  } catch {
    /* nothing to clear */
  }
}