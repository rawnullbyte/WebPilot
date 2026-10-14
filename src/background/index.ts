/**
 * The background router.
 *
 * Owns the single `Agent` instance and connects it to the panels. Its job is
 * mostly translation: every request arrives without a tab attached, and every
 * answer has to go back to whichever panels are showing *that* tab.
 *
 * Three things here are load-bearing:
 *
 *  - **Everything is scoped to a tab.** Sessions, runs, prompts and events are
 *    all keyed by tab, because that is what makes switching tabs feel like
 *    switching conversations. A panel registered against tab 3 receives tab 3's
 *    events and nothing else; a panel with no tab (the popup, the settings page)
 *    receives everything, since it is not showing any particular page.
 *
 *  - **Pending prompts are promises resolved by id, and always time out.** When
 *    the agent needs approval or an answer, it awaits a promise settled only by a
 *    panel sending back the matching id. Each also carries a timeout, because a
 *    panel can be closed, a phone can be locked, or the sidebar torn down
 *    mid-run — and an agent blocked forever on a promise is indistinguishable
 *    from a hung extension.
 *
 *  - **Prompts are re-raised for late panels.** A prompt is recorded on the
 *    session before it is emitted, so a panel that connects afterwards — which
 *    is the normal case when the overlay is injected on demand — still renders
 *    it and can answer, rather than showing a transcript with no way forward.
 */

import { ext, isConfigured, loadSettings, saveSettings } from '@/shared/settings'
import type { BgEvent, BgRequest, Settings as SettingsType, UiSurface } from '@/shared/types'
import { agent } from './agent'
import { getModels, testSettings } from './actions'
import { pruneSessions } from './sessions-store'

/* -------------------------------------------------------------------------- */
/*  UI registry                                                                */
/* -------------------------------------------------------------------------- */

type RegisteredUi = {
  port: chrome.runtime.Port
  surface: UiSurface
  /** The tab this panel is showing, or null when it is not tab-specific. */
  tabId: number | null
}

const panels = new Set<RegisteredUi>()

/** Panels that should receive events for a tab: its own, plus the unscoped. */
function panelsFor(tabId: number): RegisteredUi[] {
  return [...panels].filter((p) => p.tabId == null || p.tabId === tabId)
}

function emit(tabId: number, event: BgEvent): number {
  let delivered = 0
  for (const panel of panelsFor(tabId)) {
    try {
      panel.port.postMessage(event)
      delivered++
    } catch {
      panels.delete(panel)
    }
  }
  return delivered
}

/* -------------------------------------------------------------------------- */
/*  Pending prompts                                                            */
/* -------------------------------------------------------------------------- */

type Pending<T> = { resolve: (value: T) => void, timer: ReturnType<typeof setTimeout> }

const pendingApprovals = new Map<string, Pending<boolean> & { tabId: number }>()
const pendingQuestions = new Map<string, Pending<string> & { tabId: number }>()

/** How long to wait for a person before giving up and failing closed. */
const PROMPT_TIMEOUT_MS = 5 * 60_000

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function awaitApproval(
  tabId: number,
  id: string,
  action: string,
  reason: string,
): Promise<boolean> {
  /*
   * Record it on the session *before* emitting. Injecting a panel and then
   * emitting immediately races that panel's own start-up — `executeScript`
   * resolves long before the overlay's React tree has connected — so the emit
   * finds nobody. Holding it on the session means whichever panel arrives, now
   * or a moment later, can see and answer it.
   */
  agent.sessionFor(tabId).approval = { id, action, reason }

  if (emit(tabId, { type: 'agent/approval', id, action, reason }) === 0) {
    // Nobody is watching. Make a panel appear rather than block for five minutes
    // on a prompt no human will ever see.
    await ensureOverlay(tabId)
    emit(tabId, { type: 'agent/approval', id, action, reason })
  }

  return new Promise<boolean>((resolve) => {
    const settle = (approved: boolean) => {
      const entry = pendingApprovals.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      pendingApprovals.delete(id)
      const session = agent.sessionFor(tabId)
      if (session.approval?.id === id) session.approval = null
      resolve(approved)
    }

    const timer = setTimeout(() => {
      // Fail closed: an unanswered prompt is not consent.
      settle(false)
    }, PROMPT_TIMEOUT_MS)

    pendingApprovals.set(id, { resolve: settle, timer, tabId })
  })
}

async function awaitQuestion(tabId: number, id: string, text: string): Promise<string> {
  agent.sessionFor(tabId).question = { id, text }

  if (emit(tabId, { type: 'agent/question', id, text }) === 0) {
    await ensureOverlay(tabId)
    emit(tabId, { type: 'agent/question', id, text })
  }

  return new Promise<string>((resolve) => {
    const settle = (answer: string) => {
      const entry = pendingQuestions.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      pendingQuestions.delete(id)
      const session = agent.sessionFor(tabId)
      if (session.question?.id === id) session.question = null
      resolve(answer)
    }

    const timer = setTimeout(() => settle(''), PROMPT_TIMEOUT_MS)
    pendingQuestions.set(id, { resolve: settle, timer, tabId })
  })
}

/** Releases every prompt belonging to one tab, when nothing can answer it. */
function releasePromptsFor(tabId: number): void {
  for (const [id, entry] of [...pendingApprovals]) {
    if (entry.tabId !== tabId) continue
    // Fail closed: a prompt nobody can see is not consent.
    entry.resolve(false)
    pendingApprovals.delete(id)
  }
  for (const [id, entry] of [...pendingQuestions]) {
    if (entry.tabId !== tabId) continue
    entry.resolve('')
    pendingQuestions.delete(id)
  }
  const session = agent.sessionFor(tabId)
  session.question = null
  session.approval = null
}

/* -------------------------------------------------------------------------- */
/*  Overlay injection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The built path of the in-page panel.
 *
 * Must match the `name` for the overlay entry in `scripts/vite-config.mjs`,
 * because the two are wired together only by this string. `scripts/check.mjs`
 * verifies that every `src/*.js` path appearing in a built bundle exists in
 * `dist/`, which is what catches a drift — the failure is otherwise invisible,
 * since the only symptom is a panel that never appears on Android, where there
 * is no sidebar to fall back to.
 */
const OVERLAY_BUNDLE = 'src/overlay/overlay.js'

/** Pages Firefox will not let any extension inject into. */
const UNINJECTABLE = /^(about|moz-extension|chrome|edge|view-source|data|file|resource):/i

async function ensureOverlay(tabId: number): Promise<void> {
  try {
    const tab = await ext.tabs.get(tabId)
    if (!tab.url || UNINJECTABLE.test(tab.url)) return
    await ext.scripting.executeScript({ target: { tabId }, files: [OVERLAY_BUNDLE] })
  } catch (err) {
    /*
     * Logged rather than swallowed. This is the only path that surfaces the
     * panel on Android, and a silent failure here presents as "the button does
     * nothing" with no clue why — which is exactly how a stale bundle path went
     * unnoticed.
     */
    console.warn('[WebPilot] could not inject the in-page panel', err)
  }
}

/* -------------------------------------------------------------------------- */
/*  Badge                                                                      */
/* -------------------------------------------------------------------------- */

const BADGE = {
  working: { text: '…', color: '#2f6fed' },
  waiting: { text: '!', color: '#d98218' },
  done: { text: '✓', color: '#2f9e5f' },
  error: { text: '!', color: '#d64545' },
  stopped: { text: '', color: '#2f6fed' },
  idle: { text: '', color: '#2f6fed' },
} as const

/**
 * Updates the toolbar badge for one tab.
 *
 * Per tab, not global: the badge is on the tab's own toolbar button, and its
 * whole purpose is to tell you which of your tabs is busy while you are looking
 * at a different one.
 */
function updateBadge(tabId: number, status: keyof typeof BADGE): void {
  const spec = BADGE[status] ?? BADGE.idle
  Promise.resolve(ext.action.setBadgeText({ tabId, text: spec.text })).catch(() => {})
  Promise.resolve(ext.action.setBadgeBackgroundColor({ tabId, color: spec.color })).catch(() => {})
  Promise.resolve(
    ext.action.setTitle({ tabId, title: spec.text ? `WebPilot — ${status}` : 'WebPilot' }),
  ).catch(() => {})
}

/* -------------------------------------------------------------------------- */
/*  Agent wiring                                                               */
/* -------------------------------------------------------------------------- */

agent.subscribe((tabId, event, session) => {
  if (event.kind === 'status') updateBadge(tabId, session.status)
  emit(tabId, { type: 'agent/event', event })
})

agent.setAsker({
  approve(tabId, action, reason) {
    if (panelsFor(tabId).length === 0) return Promise.resolve(false)
    return awaitApproval(tabId, newId('ap'), action, reason)
  },
  ask(tabId, id, question) {
    if (panelsFor(tabId).length === 0) return Promise.resolve('')
    // The id comes from the agent and is already on the session, so a panel that
    // connects mid-question can re-raise and answer the same prompt.
    return awaitQuestion(tabId, id, question)
  },
})

/* -------------------------------------------------------------------------- */
/*  Request handling                                                           */
/* -------------------------------------------------------------------------- */

async function handleRequest(req: BgRequest, tabId: number | null): Promise<unknown> {
  /*
   * Wait for the stored sessions to come back before answering anything.
   *
   * This is the first thing every request does, because serving a request from a
   * half-restored state would present an empty transcript for a tab that has
   * one — which is precisely the symptom of the bug persistence exists to fix.
   */
  await agent.ready()

  const requireTab = (): number => {
    if (tabId == null) throw new Error('No tab to work on.')
    return tabId
  }

  switch (req.type) {
    case 'agent/run': {
      const id = requireTab()
      const settings = await loadSettings()
      if (!isConfigured(settings)) {
        return { ok: false, error: 'Add your endpoint, key and model in Settings first.' }
      }
      // Fire and forget: the run reports progress through events, not through
      // this reply, and awaiting it would block the message channel for minutes.
      void agent.run(req.prompt, id).catch((err) => {
        console.error('[WebPilot] agent run failed', err)
      })
      return { ok: true }
    }

    case 'agent/stop':
      agent.stop(requireTab())
      return { ok: true }

    case 'agent/approve': {
      const entry = pendingApprovals.get(req.id)
      // Resolving clears its own timer and the session record.
      if (entry) entry.resolve(req.approved)
      return { ok: true }
    }

    case 'agent/answer': {
      const entry = pendingQuestions.get(req.id)
      if (entry) entry.resolve(req.answer)
      return { ok: true }
    }

    case 'agent/clear':
      agent.clear(requireTab())
      return { ok: true }

    case 'agent/unqueue':
      return { ok: agent.unqueue(requireTab(), req.prompt) }

    case 'agent/state':
      // The session for the requesting tab, or every session when the caller is
      // not scoped to one (the popup asking for an overview).
      return tabId == null
        ? { session: null, sessions: agent.tabIds.map((id) => agent.sessionFor(id)) }
        : { session: agent.sessionFor(tabId) }

    case 'settings/get':
      return { settings: await loadSettings() }

    case 'settings/set':
      return { settings: await saveSettings(req.patch) }

    case 'settings/test': {
      const settings = await loadSettings()
      return testSettings(settings)
    }

    case 'settings/models': {
      const settings = await loadSettings()
      return getModels(settings)
    }

    case 'ui/register':
      // Handled over the port path; this exists for one-shot callers.
      return { ok: true }

    case 'ui/open-overlay': {
      const id = requireTab()
      await ensureOverlay(id)
      return { ok: true }
    }

    case 'ui/close-overlay': {
      const id = requireTab()
      try {
        await ext.tabs.sendMessage(id, { type: 'overlay/close' }, { frameId: 0 })
      } catch {
        /* no overlay present */
      }
      return { ok: true }
    }

    case 'ui/toggle-overlay': {
      const id = requireTab()
      try {
        await ext.tabs.sendMessage(id, { type: 'overlay/toggle' }, { frameId: 0 })
      } catch {
        await ensureOverlay(id)
      }
      return { ok: true }
    }

    case 'ui/which-surface': {
      const anyBrowser = ext as unknown as { sidebarAction?: { open?: unknown } }
      return { surface: anyBrowser.sidebarAction?.open ? 'sidebar' : 'overlay' }
    }

    case 'ui/open-panel': {
      const anyBrowser = ext as unknown as { sidebarAction?: { open(): Promise<void> } }

      // On desktop both surfaces exist, and the sidebar is the better one: it
      // survives navigation and does not cover the page. On Android there is no
      // sidebar, so the overlay is the only option.
      if (anyBrowser.sidebarAction?.open) {
        try {
          await anyBrowser.sidebarAction.open()
          return { ok: true, surface: 'sidebar' }
        } catch {
          // The sidebar can refuse to open if the browser is not showing it.
          // Fall through rather than leaving the user with no UI.
        }
      }
      if (tabId != null) await ensureOverlay(tabId)
      return { ok: true, surface: 'overlay' }
    }

    default:
      return { ok: false, error: `Unknown request "${(req as { type: string }).type}"` }
  }
}

async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Ports                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Panels connect over a long-lived port so the background can push events
 * without polling, and so a panel closing is noticed immediately — the port's
 * `onDisconnect` is the only reliable teardown signal across both Firefox and
 * Chromium.
 */
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webpilot-panel') return

  let entry: RegisteredUi | null = null

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'ui/register') {
      /*
       * Replace any existing registration for this port rather than adding a
       * second one. A panel re-registers every time the tab it is showing
       * changes — that is how the sidebar follows the user across tabs — and
       * adding instead of replacing would leave the same port registered twice,
       * so every event would be delivered twice and the transcript would show
       * each step duplicated.
       */
      if (entry) panels.delete(entry)

      entry = {
        port,
        surface: msg.surface as UiSurface,
        // The tab the panel reports, falling back to the tab its document lives
        // in. The sidebar reports explicitly because a sidebar document belongs
        // to a window, not to a tab, so its sender carries no useful tab id.
        tabId: typeof msg.tabId === 'number' ? msg.tabId : (port.sender?.tab?.id ?? null),
      }
      panels.add(entry)
      console.debug(
        `[WebPilot] panel registered: surface=${entry.surface} tab=${entry.tabId ?? '(unscoped)'}`,
      )

      /*
       * Bring the new panel up to date immediately, so a panel that mounts
       * mid-run renders the task in progress rather than an empty transcript.
       *
       * A panel with no tab of its own — the toolbar popup — is pointed at
       * whichever tab the user is looking at, since that is the conversation a
       * popup should be reporting on. Without this it would show a blank state
       * until the first live event arrived.
       *
       * `agent.ready()` first, always: after a background restart the sessions
       * are still being read back from storage, and sending state before that
       * finishes would hand this panel an empty transcript for a tab that has
       * one — the exact symptom persistence was added to remove.
       */
      void (async () => {
        await agent.ready()
        // `entry` is captured by the closure below and may have been replaced by
        // a re-registration in the meantime; bail if that happened.
        const target = entry
        if (!target || target.port !== port) return

        if (target.tabId == null) {
          const id = await activeTabId()
          if (id == null || entry !== target) return
          target.tabId = id
        }

        const tabId = target.tabId
        if (tabId == null) return

        const session = agent.sessionFor(tabId)
        try {
          port.postMessage({ type: 'agent/state', tabId, session } satisfies BgEvent)

          // If the agent is blocked on a prompt, re-raise it here too: a panel
          // opened after the fact must still be able to answer it.
          if (session.question) {
            port.postMessage({
              type: 'agent/question',
              id: session.question.id,
              text: session.question.text,
            } satisfies BgEvent)
          }
          if (session.approval) {
            port.postMessage({
              type: 'agent/approval',
              id: session.approval.id,
              action: session.approval.action,
              reason: session.approval.reason,
            } satisfies BgEvent)
          }
        } catch {
          /* panel went away */
        }
      })()
      return
    }

    // Everything else is a normal request, answered on the same port and scoped
    // to the tab this panel registered with.
    const requestTab = entry?.tabId ?? port.sender?.tab?.id ?? null
    void handleRequest(msg as BgRequest, requestTab)
      .then((result) => {
        try {
          port.postMessage({ type: 'reply', id: msg?.id, result })
        } catch {
          /* panel went away */
        }
      })
      .catch((err) => {
        try {
          port.postMessage({
            type: 'reply',
            id: msg?.id,
            result: { ok: false, error: err instanceof Error ? err.message : String(err) },
          })
        } catch {
          /* panel went away */
        }
      })
  })

  port.onDisconnect.addListener(() => {
    if (entry) panels.delete(entry)

    /*
     * Release anything the departed panel was holding — but only when no panel
     * remains for that tab. Closing the sidebar while an overlay on the same tab
     * is still open must not cancel a prompt the overlay is showing.
     */
    const tabId = entry?.tabId
    if (tabId != null && panelsFor(tabId).length === 0) releasePromptsFor(tabId)
  })
})

/* -------------------------------------------------------------------------- */
/*  One-shot messages (popup, content scripts)                                 */
/* -------------------------------------------------------------------------- */

ext.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  // Frames announce themselves on load. Nothing to do — the bridge probes on
  // demand — but answering stops the sender logging an unhandled rejection.
  if (msg?.type === 'frame/ready') {
    sendResponse({ ok: true })
    return false
  }

  void (async () => {
    // A one-shot message carries its tab in the sender, since it has no port to
    // register against. The popup has no tab of its own, so it falls back to
    // whichever tab the user is looking at.
    const tabId = sender?.tab?.id ?? (await activeTabId())
    return handleRequest(msg as BgRequest, tabId)
  })()
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )

  return true // async
})

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

// Settings changes can alter the rate limit mid-run; keep the limiter honest.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if ('webpilot.settings' in changes) {
    const next = changes['webpilot.settings'].newValue as SettingsType | undefined
    if (next) agent.rateLimiter.setLimit(next.rateLimit)
  }
})

// A tab closing takes its conversation with it. Without this the session map
// would grow for the life of the browser session, holding full transcripts for
// tabs that no longer exist.
ext.tabs.onRemoved.addListener((tabId) => {
  agent.forget(tabId)
  for (const panel of [...panels]) {
    if (panel.tabId === tabId) panels.delete(panel)
  }
})

// Highlights are drawn into the page, so they vanish on navigation. If a run is
// in flight, bring the panel back — otherwise the user loses sight of what the
// agent is doing, and on Android loses the ability to answer it.
ext.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return
  if (!agent.isRunning(details.tabId)) return
  // The overlay is destroyed by the navigation too, so re-inject it.
  await ensureOverlay(details.tabId)
})

/*
 * Flush when the event page is about to be suspended.
 *
 * `runtime.onSuspend` is the API for this; the DOM `unload` event is not, and a
 * listener on it would simply never fire.
 *
 * This is best effort and is treated as such. The callback cannot usefully await
 * anything — the page is being torn down regardless — so the *real* guarantee
 * comes from the debounced save after every mutation, which keeps the gap
 * between what is in memory and what is on disk down to a few hundred
 * milliseconds. What this adds is a chance to close that gap entirely on a clean
 * suspension, which is the common case.
 */
ext.runtime.onSuspend?.addListener(() => {
  void agent.flush()
})

/*
 * The same flush, reachable from outside.
 *
 * Assigning onto `globalThis` is not the usual way to expose anything, and here
 * it is deliberate: the background bundle runs in its own scope inside the
 * browser (and inside a test sandbox), and this is the one handle a test needs to
 * simulate a suspension. It is inert in production — nothing calls it.
 */
;(globalThis as unknown as { __webpilotFlush?: () => Promise<void> }).__webpilotFlush = () =>
  agent.flush()

void agent.ready().then(() => console.info('[WebPilot] background ready'))

/*
 * Drop sessions for tabs that closed while the background was asleep. A
 * `tabs.onRemoved` listener only fires while the event page is awake, so a tab
 * closed during a shutdown would otherwise leave its transcript stored forever.
 */
void agent.ready().then(async () => {
  try {
    const tabs = await ext.tabs.query({})
    await pruneSessions(new Set(tabs.map((t) => t.id).filter((id): id is number => id != null)))
  } catch {
    /* not worth reporting; the cap in the store still bounds growth */
  }
})