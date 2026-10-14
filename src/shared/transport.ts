/**
 * How a panel talks to the background.
 *
 * Every panel — sidebar, in-page overlay, popup — uses this same client, so all
 * three surfaces behave identically and can be swapped for one another without
 * the background knowing the difference.
 *
 * It uses a long-lived port rather than one-shot `sendMessage`. The reason is
 * the agent: a run takes minutes and pushes dozens of events, and a port gives
 * the background a push channel plus a reliable teardown signal. With one-shot
 * messages the panel would have to poll, and the background would never learn
 * that the user closed the sidebar to release an approval prompt.
 */

import { ext } from './settings'
import type { AgentSessionState, BgEvent, BgRequest, Settings } from './types'

export type PanelClient = {
  /** Registers this panel as a live event sink. */
  connect(surface: 'sidebar' | 'overlay' | 'popup', tabId?: number | null): void
  disconnect(): void
  onEvent(fn: (event: BgEvent) => void): () => void
  request<T = unknown>(req: BgRequest): Promise<T>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
}

export function createPanelClient(): PanelClient {
  let port: chrome.runtime.Port | null = null
  let seq = 0
  const listeners = new Set<(event: BgEvent) => void>()
  const inflight = new Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void }>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connecting: Promise<chrome.runtime.Port> | null = null
  let wantedSurface: { surface: 'sidebar' | 'overlay' | 'popup', tabId: number | null } | null = null

  function open(): Promise<chrome.runtime.Port> {
    if (port) return Promise.resolve(port)
    if (connecting) return connecting

    connecting = new Promise<chrome.runtime.Port>((resolve, reject) => {
      let p: chrome.runtime.Port
      try {
        p = ext.runtime.connect({ name: 'webpilot-panel' })
      } catch (err) {
        connecting = null
        return reject(err instanceof Error ? err : new Error(String(err)))
      }

      p.onMessage.addListener((raw: any) => {
        // Replies to requests we made.
        if (raw?.type === 'reply') {
          const entry = inflight.get(raw.id)
          if (entry) {
            inflight.delete(raw.id)
            const result = raw.result as { ok?: boolean, error?: string }
            if (result && typeof result === 'object' && result.ok === false && result.error) {
              entry.reject(new Error(result.error))
            } else {
              entry.resolve(raw.result)
            }
          }
          return
        }
        // Everything else is an event for the UI.
        for (const fn of listeners) {
          try {
            fn(raw as BgEvent)
          } catch {
            /* a broken listener must not break the port */
          }
        }
      })

      p.onDisconnect.addListener(() => {
        port = null
        connecting = null

        /*
         * Settle everything still waiting. Clearing the map without rejecting
         * would leave each caller's promise pending forever — the timeout guard
         * only fires `if (inflight.has(id))`, and the entry is already gone — so
         * a settings save or an initial load that happened to be in flight when
         * the background reloaded would leave its UI stuck on a spinner.
         */
        for (const [id, entry] of inflight) {
          entry.reject(new Error('WebPilot was reloaded. Reload this page and try again.'))
          inflight.delete(id)
        }

        // The background reloads on every extension update, which kills the
        // port. Reconnect rather than silently going deaf — otherwise the panel
        // looks alive but never updates again.
        const err = ext.runtime.lastError
        if (err && /extension context invalidated/i.test(err.message ?? '')) {
          // The whole extension was reloaded; this page can no longer talk to
          // it at all, and the honest thing is to say so.
          for (const fn of listeners) {
            try {
              fn({ type: 'agent/event', event: { kind: 'status', status: 'error', note: 'Reconnect needed' } })
            } catch { /* ignore */ }
          }
          return
        }
        if (wantedSurface && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            if (!wantedSurface) return
            void connect(wantedSurface.surface, wantedSurface.tabId)
          }, 500)
        }
      })

      port = p
      resolve(p)
    })

    return connecting
  }

  async function connect(
    surface: 'sidebar' | 'overlay' | 'popup',
    tabId: number | null = null,
  ): Promise<void> {
    wantedSurface = { surface, tabId }
    const p = await open()
    p.postMessage({ type: 'ui/register', surface, tabId })
  }

  function disconnect(): void {
    wantedSurface = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    try {
      port?.disconnect()
    } catch {
      /* already gone */
    }
    port = null
    connecting = null
  }

  async function request<T>(req: BgRequest): Promise<T> {
    const p = await open()
    const id = `r${++seq}`
    return new Promise<T>((resolve, reject) => {
      inflight.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const timer = setTimeout(() => {
        if (inflight.has(id)) {
          inflight.delete(id)
          reject(new Error('The background did not answer in time.'))
        }
      }, 60_000)

      const settle = inflight.get(id)!
      inflight.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          settle.resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          settle.reject(e)
        },
      })

      try {
        p.postMessage({ ...req, id })
      } catch (err) {
        inflight.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    connect,
    disconnect,
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    request,
    async getSettings() {
      const res = await request<{ settings: Settings }>({ type: 'settings/get' })
      return res.settings
    },
    async saveSettings(patch) {
      const res = await request<{ settings: Settings }>({ type: 'settings/set', patch })
      return res.settings
    },
  }
}

/**
 * Folds one event into the state a panel is showing.
 *
 * `ownTabId` is the tab this panel is displaying. It exists so that a state
 * snapshot can be *rejected* when it does not describe that tab — which matters
 * far more than it sounds. Replacing state unconditionally means a snapshot for
 * another tab, or a stale one arriving after a re-registration, blanks a live
 * transcript: the chat appears to reset to a fresh one while the run carries on.
 * That was a real bug, and it looked exactly like "it randomly closes".
 */
export function applyEvent(
  state: AgentSessionState,
  event: BgEvent,
  ownTabId: number | null = null,
): AgentSessionState {
  switch (event.type) {
    case 'agent/state': {
      // A snapshot for a different tab is not ours to display.
      if (event.tabId != null && ownTabId != null && event.tabId !== ownTabId) return state
      /*
       * Take identity from the snapshot when we did not have it. This is how the
       * overlay and the sidebar, neither of which knows its own tab id at first,
       * learn which conversation they are showing — and it is what lets the
       * background address their requests to the right tab.
       */
      return {
        ...event.session,
        tabId: event.session.tabId ?? event.tabId ?? state.tabId,
      }
    }
    case 'agent/event': {
      const e = event.event
      if (e.kind === 'cleared') {
        return {
          ...state,
          messages: [],
          steps: [],
          question: null,
          approval: null,
          stream: EMPTY_STREAM,
          turns: {},
          status: 'idle',
        }
      }
      if (e.kind === 'stream') {
        /*
         * Accumulate, or clear when the producer says it is done. The `done` flag
         * matters because an empty chunk is indistinguishable from "no change" —
         * without it, text would linger on screen after the turn finished and
         * appear to be still streaming.
         */
        const slot = e.stream.id === 'thinking' ? 'thinking' : 'answer'
        const next = e.stream.done ? '' : state.stream[slot] + e.stream.text
        return { ...state, stream: { ...state.stream, [slot]: next } }
      }
      if (e.kind === 'status') {
        return {
          ...state,
          status: e.status,
          note: e.note,
          // Once the agent is moving again, whatever it was waiting on is moot.
          approval: e.status === 'waiting' ? state.approval : null,
        }
      }
      if (e.kind === 'step') {
        // A step means the turn resolved into an action, so anything still
        // streaming has served its purpose.
        return {
          ...state,
          steps: [...state.steps, e.step].slice(-200),
          stream: EMPTY_STREAM,
        }
      }
      if (e.kind === 'message') {
        return { ...state, messages: [...state.messages, e.message].slice(-100), stream: EMPTY_STREAM }
      }
      return state
    }
    case 'agent/question':
      return { ...state, question: { id: event.id, text: event.text }, status: 'waiting' }
    case 'agent/approval':
      return {
        ...state,
        status: 'waiting',
        approval: { id: event.id, action: event.action, reason: event.reason },
      }
    default:
      return state
  }
}

const EMPTY_STREAM = { thinking: '', answer: '' }

export const EMPTY_SESSION: AgentSessionState = {
  status: 'idle',
  messages: [],
  steps: [],
  question: null,
  approval: null,
  stream: EMPTY_STREAM,
  turns: {},
  queue: [],
  tabId: null,
}