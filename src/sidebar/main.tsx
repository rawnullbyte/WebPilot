import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Panel } from '@/components/panel'
import { ext } from '@/shared/settings'
import '@/styles/globals.css'

/**
 * The desktop sidebar.
 *
 * Unlike the overlay, this is a document docked to a *window* rather than living
 * inside a tab, so the background has no tab to attribute its requests to. The
 * sidebar is also the only context that can answer the question reliably:
 * `tabs.query({ active: true, currentWindow: true })` resolves against the
 * sidebar's own window, which is exactly the tab the user is looking at.
 */
function Sidebar() {
  const [tabId, setTabId] = React.useState<number | null>(null)
  /** Set once the tab has been resolved at least once, successfully or not. */
  const [ready, setReady] = React.useState(false)
  /** The last id we successfully resolved. Never goes back to null. */
  const lastKnown = React.useRef<number | null>(null)

  React.useEffect(() => {
    let alive = true

    const resolve = async () => {
      try {
        const [tab] = await ext.tabs.query({ active: true, currentWindow: true })
        if (!alive) return
        if (tab?.id != null) {
          lastKnown.current = tab.id
          setTabId(tab.id)
        }
      } catch {
        // Querying can fail transiently while a window is being torn down. Fall
        // through and keep whatever we had.
      } finally {
        if (alive) setReady(true)
      }
    }

    void resolve()

    /*
     * Only `onActivated` is watched — deliberately not `onRemoved`.
     *
     * `onRemoved` fires for *any* tab closing anywhere in the browser, and the
     * re-resolve it triggers can land in the gap between one tab closing and the
     * next becoming active, when `tabs.query({active})` legitimately returns
     * nothing. Adopting that null unmounted the whole panel, dropping the port
     * connection and the transcript with it — which is what made the sidebar
     * appear to close at random. Closing the active tab still re-resolves,
     * because the browser activates a replacement and fires `onActivated`.
     */
    const onActivated = () => void resolve()
    ext.tabs.onActivated?.addListener(onActivated)

    return () => {
      alive = false
      ext.tabs.onActivated?.removeListener(onActivated)
    }
  }, [])

  // A placeholder only until the first resolve. After that the panel is never
  // unmounted, so its connection and transcript survive any transient failure.
  if (!ready) return <div className="h-full bg-background" />

  /*
   * Keyed by tab, so switching tabs remounts the panel. That is deliberate and
   * it is what gives each tab its own conversation: the remount re-registers the
   * port against the new tab and pulls that tab's transcript, while the previous
   * tab's run carries on in the background untouched.
   */
  return <Panel key={tabId} surface="sidebar" tabId={tabId} chrome={{ className: 'h-full' }} />
}

const el = document.getElementById('root')
if (!el) throw new Error('WebPilot: sidebar root element is missing.')

createRoot(el).render(
  <React.StrictMode>
    <Sidebar />
  </React.StrictMode>,
)