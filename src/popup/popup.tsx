import * as React from 'react'
import {
  PanelRight,
  PanelTop,
  Settings as SettingsIcon,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/timeline'
import { BrandMark } from '@/components/panel'
import { panelClient } from '@/components/use-panel'
import { Composer } from '@/components/composer'
import { applyEvent, EMPTY_SESSION } from '@/shared/transport'
import type { AgentSessionState, BgEvent, Settings } from '@/shared/types'

type Target = 'sidebar' | 'overlay'

/**
 * The toolbar popup.
 *
 * Deliberately not the main interface. A popup is destroyed the instant it loses
 * focus, which on a phone happens when you switch apps and on a desktop happens
 * when you click the page. An agent run outlives both.
 *
 * So this is a launcher: it starts the task, then gets out of the way by opening
 * the sidebar on desktop or the in-page panel on Android, where the run can
 * actually be watched and answered.
 */
export function Popup() {
  const client = React.useMemo(() => panelClient(), [])
  const [session, setSession] = React.useState<AgentSessionState>(EMPTY_SESSION)
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [target, setTarget] = React.useState<Target>('sidebar')
  const [error, setError] = React.useState<string | null>(null)
  /**
   * The last tab id the agent reported.
   *
   * Kept separately because the session snapshot resets `tabId` to null whenever
   * nothing is running, and this popup may be opened before a run starts. Without
   * it the "Open sidebar" / "Show panel" label flickers back to the wrong
   * surface the moment any event arrives.
   */
  const [knownTabId, setKnownTabId] = React.useState<number | null>(null)

  React.useEffect(() => {
    // Register as a panel so the status line is live while the popup is open.
    client.connect('popup', null)
    const off = client.onEvent((event: BgEvent) => {
      setSession((prev) => {
        const next = applyEvent(prev, event)
        if (next.tabId != null) setKnownTabId(next.tabId)
        return next
      })
    })
    client.getSettings().then(setSettings).catch(() => {})

    // Ask the background which surface this browser actually has. Firefox for
    // Android has no sidebar at all, so the popup must offer the in-page panel
    // there instead — and it must not offer a button that does nothing.
    client
      .request<{ surface?: Target }>({ type: 'ui/which-surface' })
      .then((res) => {
        if (res?.surface) setTarget(res.surface)
      })
      .catch(() => {})

    return () => {
      off()
    }
  }, [client])

  const openOptions = () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome
    api.runtime.openOptionsPage?.()
    window.close()
  }

  const openPanel = async () => {
    // The background resolves the tab from the port's sender, so no tab id is
    // needed here.
    await client.request({ type: 'ui/open-panel' }).catch(() => {})
    window.close()
  }

  const run = async (text: string) => {
    setError(null)
    try {
      const res = await client.request<{ ok?: boolean, error?: string }>({
        type: 'agent/run',
        prompt: text,
      })
      if (res && res.ok === false) {
        setError(res.error ?? 'Could not start.')
        return
      }
      // Hand off immediately: the run belongs to the background, and this popup
      // is about to be destroyed underneath it.
      await openPanel()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const stop = () => void client.request({ type: 'agent/stop' }).catch(() => {})

  const configured = Boolean(settings?.endpoint && settings?.model)
  const running = session.status === 'working' || session.status === 'waiting'

  return (
    <div className="flex w-[340px] flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <BrandMark className="size-4 text-running" />
        <span className="text-[13px] font-semibold tracking-tight">WebPilot</span>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusPill status={session.status} note={session.note} />
          <Button variant="ghost" size="icon-xs" onClick={openOptions} aria-label="Settings">
            <SettingsIcon className="size-3.5" />
          </Button>
        </div>
      </header>

      {!configured ? (
        <div className="space-y-3 p-4">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            WebPilot needs a model before it can do anything. Add an OpenAI-compatible
            endpoint, your key, and the model name.
          </p>
          <Button size="sm" className="w-full" onClick={openOptions}>
            Open Settings
          </Button>
        </div>
      ) : (
        <>
          {session.steps.length > 0 && (
            <div className="wp-scroll max-h-32 overflow-y-auto border-b">
              {session.steps.slice(-4).map((step) => (
                <div key={step.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span
                    className={
                      step.kind === 'error'
                        ? 'text-destructive'
                        : step.kind === 'answer'
                          ? 'text-running'
                          : 'text-muted-foreground'
                    }
                  >
                    ·
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">{step.title}</span>
                </div>
              ))}
            </div>
          )}

          <div className="p-3">
            <Composer
              onSubmit={(text) => void run(text)}
              onStop={stop}
              running={running}
              placeholder={running ? 'Working — open the panel to watch' : 'What should WebPilot do?'}
            />
            {error && (
              <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-2 border-t p-3">
            <Button variant="outline" size="sm" className="flex-1" onClick={openPanel}>
              {target === 'sidebar' ? (
                <PanelRight className="size-3.5" />
              ) : (
                <PanelTop className="size-3.5" />
              )}
              {target === 'sidebar' ? 'Open sidebar' : 'Show panel'}
            </Button>
            {running && (
              <Button variant="outline" size="sm" onClick={stop}>
                <Square className="size-3.5" />
                Stop
              </Button>
            )}
          </div>
        </>
      )}

      <p className="border-t px-3 py-2 text-[10px] leading-snug text-muted-foreground">
        Runs on your own endpoint. Your key never leaves this device.
        {knownTabId != null && ` Working on tab ${knownTabId}.`}
      </p>
    </div>
  )
}