import * as React from 'react'
import { createPanelClient, applyEvent, EMPTY_SESSION, type PanelClient } from '@/shared/transport'
import type { AgentSessionState, BgEvent, Settings, UiSurface } from '@/shared/types'

/** One client per surface, shared by every component in that panel. */
let sharedClient: PanelClient | null = null
export function panelClient(): PanelClient {
  if (!sharedClient) sharedClient = createPanelClient()
  return sharedClient
}

export type PendingPrompt =
  | { kind: 'approval', id: string, action: string, reason: string }
  | { kind: 'question', id: string, text: string }

export type PanelApi = {
  session: AgentSessionState
  settings: Settings | null
  /** A prompt the agent is blocked on, if any. */
  prompt: PendingPrompt | null
  ready: boolean
  run(prompt: string): Promise<void>
  stop(): void
  clear(): void
  unqueue(prompt: string): void
  answer(id: string, answer: string): void
  approve(id: string, approved: boolean): void
  save(patch: Partial<Settings>): Promise<void>
  error: string | null
}

/**
 * Binds the background agent to a React panel.
 *
 * The transcript is rebuilt from a sequence of events rather than polled, which
 * means the client has to be resilient to the panel mounting at an arbitrary
 * point in a run — hence the `agent/state` snapshot on registration.
 */
export function usePanel(surface: UiSurface, tabId?: number | null): PanelApi {
  const client = React.useMemo(() => panelClient(), [])
  const [session, setSession] = React.useState<AgentSessionState>(EMPTY_SESSION)
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  /*
   * The tab this panel is showing, as it becomes known.
   *
   * It starts as whatever the caller passed (the sidebar resolves it itself, the
   * overlay does not) and is filled in from the first state snapshot when it is
   * still unknown. Held in a ref rather than state because the event handler
   * below reads it on every event and must not be re-created when it changes.
   */
  const ownTab = React.useRef<number | null>(tabId ?? null)
  React.useEffect(() => {
    if (tabId != null) ownTab.current = tabId
  }, [tabId])

  React.useEffect(() => {
    let alive = true

    // Capture the unsubscribe. Discarding it — which is what this used to do —
    // means every remount leaves a listener behind on the shared client. The
    // panel still renders correctly, because the `alive` guard below stops stale
    // ones doing any work, but the set grows with every tab switch and each
    // event is then walked past a growing number of dead entries. On the sidebar
    // that remounts per tab, that is a leak with a visible cost.
    const unsubscribe = client.onEvent((event: BgEvent) => {
      if (!alive) return

      // Prompt-carrying events fold into the session like everything else, and
      // the prompt is derived from it below. One source of truth means a prompt
      // arriving via the state snapshot renders identically to one arriving live.
      setSession((prev) => {
        const next = applyEvent(prev, event, ownTab.current)
        // Adopt the identity the background gives us, so later comparisons and
        // requests are scoped correctly.
        if (ownTab.current == null && next.tabId != null) ownTab.current = next.tabId
        return next
      })
    })

    // Register once the listener is attached, so the state snapshot that comes
    // back on registration is not missed. Re-registering for a new tab is what
    // loads that tab's conversation.
    client.connect(surface, tabId ?? null)
    setReady(true)
    if (tabId != null) {
      // Clear what was on screen before, so the previous tab's transcript does
      // not linger under the new tab's snapshot.
      setSession((prev) => (prev.tabId === tabId ? prev : { ...EMPTY_SESSION, tabId }))
    }

    client
      .getSettings()
      .then((s) => alive && setSettings(s))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))

    return () => {
      alive = false
      unsubscribe()
    }
    /*
     * `tabId` is a real dependency, not an oversight: the sidebar hands over to a
     * different conversation when the user switches tabs, and that is a fresh
     * registration followed by the new tab's state snapshot. Reconnecting on a
     * changed dependency is what makes switching tabs load that tab's chat.
     */
  }, [client, surface, tabId])

  // Settings can be edited in another surface (the options page) while a panel
  // is open, so re-read them when storage changes rather than only on mount.
  React.useEffect(() => {
    const onChange = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== 'local' || !('webpilot.settings' in changes)) return
      const next = changes['webpilot.settings'].newValue as Settings | undefined
      if (next) setSettings(next)
    }
    const api = (globalThis as any).browser ?? (globalThis as any).chrome
    api.storage.onChanged.addListener(onChange)
    return () => api.storage.onChanged.removeListener(onChange)
  }, [])

  /*
   * A prompt the agent is blocked on. Read from the session rather than held
   * separately, so a panel that mounts while the agent is already waiting — the
   * normal case when the overlay is injected on demand — shows the prompt rather
   * than a transcript with no way to answer it.
   */
  const prompt: PendingPrompt | null = React.useMemo(() => {
    if (session.approval) {
      return {
        kind: 'approval',
        id: session.approval.id,
        action: session.approval.action,
        reason: session.approval.reason,
      }
    }
    if (session.question) {
      return { kind: 'question', id: session.question.id, text: session.question.text }
    }
    return null
  }, [session.approval, session.question])

  const run = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setError(null)
      try {
        const res = await client.request<{ ok: boolean, error?: string }>({
          type: 'agent/run',
          prompt: trimmed,
        })
        if (res && res.ok === false) setError(res.error ?? 'Could not start.')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [client],
  )

  const stop = React.useCallback(() => {
    void client.request({ type: 'agent/stop' }).catch(() => {})
  }, [client])

  const unqueue = React.useCallback(
    (prompt: string) => {
      void client
        .request<{ ok: boolean, error?: string }>({ type: 'agent/unqueue', prompt })
        .then((res) => {
          // A prompt that has already started cannot be removed, and saying so is
          // better than a button that appears to do nothing.
          if (res && res.ok === false) setError(res.error ?? 'That prompt could not be removed.')
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    },
    [client],
  )

  const clear = React.useCallback(() => {
    void client.request({ type: 'agent/clear' }).catch(() => {})
  }, [client])

  const answer = React.useCallback(
    (id: string, text: string) => {
      void client
        .request({ type: 'agent/answer', promptId: id, answer: text })
        .catch(() => {})
    },
    [client],
  )

  const approve = React.useCallback(
    (id: string, approved: boolean) => {
      void client
        .request({ type: 'agent/approve', promptId: id, approved })
        .catch(() => {})
    },
    [client],
  )

  const save = React.useCallback(
    async (patch: Partial<Settings>) => {
      const next = await client.saveSettings(patch)
      setSettings(next)
    },
    [client],
  )

  return { session, settings, prompt, ready, run, stop, clear, unqueue, answer, approve, save, error }
}