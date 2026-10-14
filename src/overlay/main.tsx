import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Panel, BrandMark } from '@/components/panel'
import { PortalContainerContext } from '@/components/portal'
import { StatusPill } from '@/components/timeline'
import { cn } from 'cn'
import { panelClient } from '@/components/use-panel'
import { applyEvent, EMPTY_SESSION } from '@/shared/transport'
import type { AgentSessionState, BgEvent } from '@/shared/types'
import css from '@/styles/globals.css?inline'

/**
 * WebPilot's in-page panel.
 *
 * This is the surface that makes the extension work on a phone. Firefox for
 * Android has no sidebar — `sidebar_action` is desktop-only — so on mobile this
 * overlay *is* the interface.
 *
 * Everything lives inside a shadow root, for two reasons that matter equally:
 *
 *  1. **Inward.** A page's CSS cannot reach the panel. Without this, a site with
 *     `div { display: none }` or a broad `button { … }` rule would wreck the UI,
 *     and some would make it unusable entirely.
 *  2. **Outward.** Tailwind's preflight resets margins, borders and fonts on
 *     everything. Applied to the host page it would visibly break the site the
 *     user is looking at, which is a remarkable thing for a browser extension to
 *     do. Shadow DOM contains it.
 *
 * The stylesheet is inlined at build time via `?inline`, so nothing has to be
 * fetched at runtime and no CSS file needs exposing to the page.
 */

const HOST_ATTR = 'data-webpilot-ui'
const MOUNT_FLAG = '__webpilotOverlayMounted'

/* -------------------------------------------------------------------------- */
/*  Style injection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Installs the stylesheet into a shadow root.
 *
 * `adoptedStyleSheets` is the good path: one parsed sheet shared by every
 * overlay, and no extra DOM node. The `<style>` fallback exists because
 * constructing a `CSSStyleSheet` throws in some contexts, and an unstyled panel
 * is far worse than a redundant element.
 */
function installStyles(root: ShadowRoot, sheetCss: string): void {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(sheetCss)
    root.adoptedStyleSheets = [sheet]
    return
  } catch {
    /* fall through to the element form */
  }
  const style = document.createElement('style')
  style.textContent = sheetCss
  root.appendChild(style)
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/**
 * Whether to use the bottom-sheet layout.
 *
 * Matches on width rather than user agent: a narrow desktop window has the same
 * constraint as a phone, so it deserves the same layout. A fixed sidebar-style
 * card simply does not fit in 380px of a 360px screen.
 */
function isMobileLayout(): boolean {
  return window.innerWidth < 640
}

/* -------------------------------------------------------------------------- */
/*  The overlay                                                                */
/* -------------------------------------------------------------------------- */

function Overlay() {
  const [open, setOpen] = React.useState(true)
  const [minimised, setMinimised] = React.useState(false)
  const [session, setSession] = React.useState<AgentSessionState>(EMPTY_SESSION)
  const [dark, setDark] = React.useState(prefersDark)
  const [mobile, setMobile] = React.useState(isMobileLayout)

  const client = React.useMemo(() => panelClient(), [])

  // Keep the pill on the minimised bar live even when the panel is closed.
  React.useEffect(() => {
    const off = client.onEvent((event: BgEvent) => setSession((prev) => applyEvent(prev, event)))
    return () => off()
  }, [client])

  // Follow the page's light/dark setting. A white panel on a dark page is
  // jarring, and on a phone it is the brightest thing on screen.
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  React.useEffect(() => {
    const onResize = () => setMobile(isMobileLayout())
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The background and the loader shim drive open/close, so the popup can
  // summon this panel without knowing how it is built.
  React.useEffect(() => {
    const show = () => {
      setOpen(true)
      setMinimised(false)
    }
    const toggle = () =>
      setOpen((wasOpen) => {
        if (wasOpen) return false
        setMinimised(false)
        return true
      })
    const hide = () => setOpen(false)

    window.addEventListener('webpilot:show', show)
    window.addEventListener('webpilot:toggle', toggle)
    window.addEventListener('webpilot:hide', hide)

    const api = (globalThis as any).browser ?? (globalThis as any).chrome
    const onMessage = (msg: any) => {
      if (msg?.type === 'overlay/open' || msg?.type === 'overlay/show') show()
      if (msg?.type === 'overlay/toggle') toggle()
      if (msg?.type === 'overlay/close') hide()
    }
    api.runtime.onMessage.addListener(onMessage)

    return () => {
      window.removeEventListener('webpilot:show', show)
      window.removeEventListener('webpilot:toggle', toggle)
      window.removeEventListener('webpilot:hide', hide)
      api.runtime.onMessage.removeListener(onMessage)
    }
  }, [])

  if (!open) return null

  // Minimised: one small button. Lets the panel be got out of the way without
  // ending the run or losing sight of it.
  if (minimised) {
    return (
      <div className={cn(dark && 'dark')}>
        <button
          type="button"
          onClick={() => setMinimised(false)}
          style={{ pointerEvents: 'auto' }}
          className={cn(
            'fixed z-[2147483647] flex items-center gap-2 rounded-full border border-border bg-background py-2 pr-3 pl-2.5 shadow-lg transition-colors hover:bg-accent',
            mobile ? 'right-3 bottom-3' : 'right-4 bottom-4',
          )}
          aria-label="Open WebPilot"
        >
          <BrandMark className="size-4 text-running" />
          <StatusPill status={session.status} note={session.note} />
        </button>
      </div>
    )
  }

  return (
    <div className={cn(dark && 'dark')}>
      <div
        style={{ pointerEvents: 'auto' }}
        className={cn(
          'fixed z-[2147483647]',
          mobile
            ? // Bottom sheet. The thumb reaches the bottom of a phone, and the
              // sheet leaves the top of the page visible so you can watch the
              // agent working on it.
              'inset-x-0 bottom-0 h-[min(78vh,620px)] pb-[env(safe-area-inset-bottom)]'
            : // Floating card, clear of the page's own top-right controls.
              'right-4 bottom-4 h-[min(640px,calc(100vh-2rem))] w-[380px]',
        )}
      >
        <Panel
          surface="overlay"
          chrome={{
            floating: true,
            closeLabel: 'Hide panel',
            onClose: () => setOpen(false),
            onMinimise: () => setMinimised(true),
            // A bottom sheet is anchored to the screen edge, so its top corners
            // round and its bottom ones do not.
            className: mobile ? 'rounded-b-none border-b-0' : undefined,
          }}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Entry                                                                      */
/* -------------------------------------------------------------------------- */

function mount(): void {
  const w = window as any

  // Re-injection is the normal way the background summons the panel, so a second
  // mount must show the existing one rather than stacking a duplicate.
  if (w[MOUNT_FLAG]) {
    window.dispatchEvent(new CustomEvent('webpilot:show'))
    return
  }
  w[MOUNT_FLAG] = true

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, 'overlay')
  /*
   * The host covers the viewport so the panel can be positioned against it, but
   * it must not swallow clicks meant for the page underneath. `pointer-events:
   * none` on the host and on the React tree's wrappers, re-enabled only on the
   * panel card itself, is what keeps the page usable while the panel is open —
   * which matters, because the user often wants to click something the agent
   * could not.
   *
   * `all: initial` matters too: without it the host inherits the page's font,
   * line-height and colour, which then leak into our components through
   * inheritance even inside the shadow tree.
   */
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'

  const root = host.attachShadow({ mode: 'open' })
  installStyles(root, css)

  const target = document.createElement('div')
  target.style.cssText = 'pointer-events: none;'
  root.appendChild(target)

  // `documentElement` rather than `body`: some frameworks replace `body` during
  // hydration, and an overlay appended to it can be discarded along with it.
  document.documentElement.appendChild(host)

  createRoot(target).render(
    <React.StrictMode>
      {/* Portalled UI goes into the shadow root rather than the page body, so it
          keeps our styles. See components/portal.tsx. */}
      <PortalContainerContext.Provider value={root as unknown as HTMLElement}>
        <Overlay />
      </PortalContainerContext.Provider>
    </React.StrictMode>,
  )
}

mount()