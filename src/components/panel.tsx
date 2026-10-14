import * as React from 'react'
import {
  Eraser,
  Eye,
  EyeOff,
  Minus,
  PanelRight,
  Settings as SettingsIcon,
  X,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Composer } from '@/components/composer'
import { PromptCard } from '@/components/prompt-card'
import { LiveThinking, StatusPill, Timeline } from '@/components/timeline'
import { usePanel } from '@/components/use-panel'
import type { UiSurface } from '@/shared/types'

export type PanelChrome = {
  /** Rendered at the far left of the header. */
  onClose?: () => void
  closeLabel?: string
  /** Whether to offer the "open sidebar instead" affordance. */
  onOpenSidebar?: () => void
  onMinimise?: () => void
  className?: string
  /** Overlay-only: the panel is a floating card rather than a full pane. */
  floating?: boolean
}

const SUGGESTIONS = [
  'Summarise this page in a few bullet points',
  'Find the sign-up form and tell me what it asks for',
  'Search this site for “refund policy” and tell me what it says',
]

/**
 * WebPilot's whole interface.
 *
 * One component serves all three surfaces. The differences are chrome only —
 * the sidebar is a full-height pane, the overlay is a floating card or a bottom
 * sheet, the popup is a compact launcher — and everything that matters (the
 * transcript, the composer, approval prompts) is identical in each. That is
 * deliberate: the agent behaves the same way whatever you are looking at, and
 * there is one place to fix a bug.
 */
export function Panel({
  surface,
  chrome,
  tabId,
}: {
  surface: UiSurface
  chrome?: PanelChrome
  /**
   * The tab this panel is showing, when it can know it.
   *
   * The overlay does not pass one: its port's sender carries the right tab,
   * because the content script lives in that tab. The sidebar *must* pass one —
   * a sidebar is docked to a window, not a tab, so there is nothing for the
   * background to infer, and without it a run started from the sidebar is
   * attributed to whatever tab happens to be current.
   */
  tabId?: number | null
}) {
  const { session, settings, prompt, run, stop, clear, answer, approve, error } = usePanel(surface, tabId)

  const running = session.status === 'working' || session.status === 'waiting'
  const configured = Boolean(settings?.endpoint && settings?.model)
  const thinkingEnabled = settings?.showThinking !== false
  const openOptions = () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome
    api.runtime.openOptionsPage?.()
  }

  const hasTranscript = session.steps.length > 0 || session.messages.length > 0

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className={cn(
          'flex h-full min-h-0 flex-col bg-background text-foreground',
          chrome?.floating && 'overflow-hidden rounded-xl border shadow-2xl',
          chrome?.className,
        )}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                            */}
        {/* ---------------------------------------------------------------- */}
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <BrandMark className="size-4 shrink-0 text-running" />
          <span className="truncate text-[13px] font-semibold tracking-tight">WebPilot</span>

          <div className="ml-auto flex items-center gap-1.5">
            <StatusPill status={session.status} note={session.note} />

            {hasTranscript && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={clear}
                    aria-label="Clear the transcript"
                  >
                    <Eraser className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear</TooltipContent>
              </Tooltip>
            )}

            {chrome?.onOpenSidebar && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={chrome.onOpenSidebar}
                    aria-label="Open in the sidebar"
                  >
                    <PanelRight className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open sidebar</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openOptions}
                  aria-label="Settings"
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>

            {chrome?.onMinimise && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={chrome.onMinimise}
                aria-label="Minimise"
              >
                <Minus className="size-3.5" />
              </Button>
            )}

            {chrome?.onClose && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={chrome.onClose}
                aria-label={chrome.closeLabel ?? 'Close'}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* Body                                                              */}
        {/* ---------------------------------------------------------------- */}
        {/*
          The top padding lives here rather than on the thinking card, so the gap
          under the header's divider is the same whether or not the card is
          showing — otherwise the transcript would jump up by a few pixels the
          moment a run started or finished. `pt-2` mirrors the header's own
          `py-2`, which is what makes the space above and below the divider
          balance.
        */}
        <div className="flex min-h-0 flex-1 flex-col pt-2">
          {!hasTranscript ? (
            <EmptyState
              configured={configured}
              onPick={(text) => void run(text)}
              onOpenSettings={openOptions}
            />
          ) : (
            <>
              {thinkingEnabled && <LiveThinking session={session} running={running} />}
              <Timeline session={session} className="min-h-0 flex-1" />
            </>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Prompt + composer                                                 */}
        {/* ---------------------------------------------------------------- */}
        <div className="shrink-0 border-t pt-2">
          {error && (
            <p className="mx-3 mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}

          {prompt && (
            <PromptCard prompt={prompt} onAnswer={answer} onApprove={approve} />
          )}

          {session.status === 'done' || session.status === 'error' || session.status === 'stopped' ? (
            <AnswerBox text={lastAnswer(session.messages)} />
          ) : null}

          <Composer
            onSubmit={(text) => void run(text)}
            onStop={stop}
            running={running}
            disabled={!configured}
            placeholder={
              configured
                ? 'Ask WebPilot to do something on this page…'
                : 'Add your endpoint, key and model in Settings'
            }
            className="px-3 pb-3"
          />
        </div>
      </div>
    </TooltipProvider>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function EmptyState({
  configured,
  onPick,
  onOpenSettings,
}: {
  configured: boolean
  onPick: (text: string) => void
  onOpenSettings: () => void
}) {
  if (!configured) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <BrandMark className="size-8 text-running" />
        <div>
          <p className="text-[13px] font-medium">Connect a model</p>
          <p className="mt-1 max-w-[36ch] text-[12px] leading-relaxed text-muted-foreground">
            WebPilot runs entirely on your own endpoint. Add the base URL, key and model
            name, and it will start reading and driving pages for you.
          </p>
        </div>
        <Button size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col justify-center gap-2 p-4">
      <p className="px-1 text-[12px] font-medium text-muted-foreground">Try something like</p>
      {SUGGESTIONS.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          className="rounded-lg border border-border bg-card px-3 py-2 text-left text-[12px] leading-snug transition-colors hover:border-running/40 hover:bg-accent"
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** The final answer gets its own treatment — it is what the user came for. */
function AnswerBox({ text }: { text: string | null }) {
  const [shown, setShown] = React.useState(true)
  if (!text) return null

  return (
    <div className="mx-3 mb-2 rounded-lg border border-success/30 bg-success/5 p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium tracking-wide text-success uppercase">
          Answer
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Hide answer' : 'Show answer'}
        >
          {shown ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        </Button>
      </div>
      {shown && (
        <p className="wp-scroll max-h-48 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap">
          {text}
        </p>
      )}
    </div>
  )
}

function lastAnswer(messages: { role: string, text: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].text
  }
  return null
}

/** The mark: a paper plane, matching the extension icon. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M21.5 2.5 2.5 10.2l6.6 2.4 2.3 6.9 3.3-6.1"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m11.4 13.4 10.1-10.9"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}