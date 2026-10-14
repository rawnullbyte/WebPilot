import * as React from 'react'
import { cn } from 'cn'
import {
  AlertCircle,
  ArrowRight,
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  Compass,
  Eye,
  Hand,
  Keyboard,
  MousePointerClick,
  Sparkles,
  Square,
  Type as TypeIcon,
  X,
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { AgentSessionState, Step } from '@/shared/types'

/* -------------------------------------------------------------------------- */
/*  Step presentation                                                          */
/* -------------------------------------------------------------------------- */

const STEP_ICON: Record<Step['kind'], React.ComponentType<{ className?: string }>> = {
  read: Eye,
  act: MousePointerClick,
  navigate: Compass,
  answer: Sparkles,
  error: AlertCircle,
  note: Hand,
}

/** Picks a more specific icon when the step title tells us what happened. */
function iconFor(step: Step) {
  if (step.kind === 'act' || step.kind === 'navigate') {
    if (/^Typed/i.test(step.title)) return TypeIcon
    if (/^Pressed/i.test(step.title)) return Keyboard
    if (/^Hovered/i.test(step.title)) return Hand
    if (/^Scrolled/i.test(step.title)) return ArrowRight
  }
  return STEP_ICON[step.kind]
}

/* -------------------------------------------------------------------------- */
/*  One step                                                                   */
/* -------------------------------------------------------------------------- */

function StepRow({ step, last }: { step: Step, last: boolean }) {
  const Icon = iconFor(step)
  // `args` is present-but-empty for every ref action, so it only counts as
  // detail when it actually has something in it.
  const hasArgs =
    step.args != null &&
    typeof step.args === 'object' &&
    Object.keys(step.args as object).length > 0
  const hasDetail = Boolean(step.detail || step.result) || hasArgs
  const [open, setOpen] = React.useState(false)

  const row = (
    <div className="flex items-start gap-2.5 px-3 py-1.5">
      <div className="relative flex shrink-0 flex-col items-center self-stretch">
        <span
          className={cn(
            'mt-0.5 grid size-5 place-items-center rounded-full border',
            step.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : step.kind === 'answer'
                ? 'border-running/40 bg-running/10 text-running'
                : 'border-border bg-muted/60 text-muted-foreground',
          )}
        >
          <Icon className="size-3" />
        </span>
        {/* The connector is what makes a list of rows read as a sequence. */}
        {!last && <span className="mt-1 w-px flex-1 bg-border" />}
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        <p
          className={cn(
            'text-[13px] leading-snug break-words',
            step.kind === 'error' && 'text-destructive',
            step.kind === 'answer' && 'font-medium',
          )}
        >
          {step.title}
        </p>
        {step.detail && (
          <p className="mt-0.5 font-mono text-[11px] leading-snug break-words text-muted-foreground">
            {step.detail}
          </p>
        )}
      </div>

      {hasDetail && (
        <ChevronRight
          className={cn(
            'mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
      )}
    </div>
  )

  if (!hasDetail) return row

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full cursor-pointer text-left hover:bg-muted/40">
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 mb-2 ml-[34px] space-y-1.5 rounded-md border border-border bg-muted/40 p-2">
          {hasArgs && <Detail label="Arguments" value={JSON.stringify(step.args, null, 2)} />}
          {step.result && <Detail label="Result" value={step.result} />}
          {!hasArgs && !step.result && step.detail && (
            <Detail label="Detail" value={step.detail} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Detail({ label, value }: { label: string, value: string }) {
  return (
    <div>
      <p className="mb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <pre className="wp-scroll max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80">
        {value}
      </pre>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  The user's own messages                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A prompt the user typed.
 *
 * These were previously invisible: the timeline rendered `steps`, which the agent
 * produces, and user messages live in `messages`, which nothing drew. So the
 * transcript showed a sequence of actions with no indication of what had been
 * asked for — and the request that started the whole task was not on screen at
 * all.
 *
 * Visually distinct from a step, because it is a different kind of thing: a step
 * is something the agent did, a prompt is something you said.
 */
function PromptRow({ text, at }: { text: string, at: number }) {
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="mx-3 mb-2 mt-1 rounded-lg border border-running/25 bg-running/5 px-2.5 py-1.5">
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wide text-running uppercase">You</span>
        <span className="text-[10px] text-muted-foreground">{time}</span>
      </div>
      <p className="text-[13px] leading-snug whitespace-pre-wrap break-words text-foreground">
        {text}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Thinking                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A scrolling box of the model's reasoning.
 *
 * Three things about it are deliberate:
 *
 * **The text fades at both edges.** A hard cut-off mid-line reads as a bug — it
 * looks like text was truncated rather than that there is more above. A mask
 * gradient makes the same cutoff read as "this continues", which is what it is.
 * Done with `mask-image` rather than an overlay of page-coloured divs, so it
 * works whatever is behind the panel and needs no colour of its own.
 *
 * **It scrolls itself, and you cannot scroll it.** The box is a live readout,
 * not something to navigate: at several tokens a second, letting a stray flick
 * take control means the view fights the stream, and the reader ends up chasing
 * text that keeps running away. It is pinned to the newest line and the pointer
 * is taken out of the equation. The finished copy below *is* scrollable — that
 * one is a record you read, not a stream you watch.
 *
 * **It is capped in height.** Otherwise it would push the actions around as it
 * grew, and the transcript would slide up the screen continuously.
 */
function ThinkingBox({ text, live }: { text: string, live: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    // `overflow: hidden` still scrolls programmatically, which is exactly the
    // behaviour wanted here: automatic, never manual.
    el.scrollTop = el.scrollHeight
  }, [text])

  if (!text.trim()) return null

  const mask =
    'linear-gradient(to bottom, transparent 0, black 14px, black calc(100% - 14px), transparent 100%)'

  return (
    <div
      ref={ref}
      aria-live={live ? 'polite' : undefined}
      className="wp-scroll px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
      style={{
        maxHeight: '8rem',
        // A live box is locked to the newest line; a finished one is readable.
        overflowY: live ? 'hidden' : 'auto',
        pointerEvents: live ? 'none' : undefined,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    >
      {text}
      {live && (
        <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-muted-foreground align-middle" />
      )}
    </div>
  )
}

function ThinkingHeader({ live, label = 'Thinking' }: { live: boolean, label?: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1">
      <Brain className={cn('size-3 text-muted-foreground', live && 'animate-pulse')} />
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
    </div>
  )
}

/**
 * The live box: reasoning and output as they arrive, in one place.
 *
 * Shown only while something is actually streaming, and only for the newest
 * turn. Once the turn resolves it is replaced by the expandable record below, so
 * there is exactly one of these on screen at a time rather than one per turn.
 */
export function LiveThinking({ session, running }: { session: AgentSessionState, running: boolean }) {
  const { thinking, answer } = session.stream
  if (!thinking.trim() && !answer.trim()) return null

  return (
    <div className="mx-3 mb-1.5 shrink-0 overflow-hidden rounded-lg border border-running/30 bg-muted/40">
      <ThinkingHeader live={running} />
      {thinking.trim() && <ThinkingBox text={thinking} live={running} />}
      {/*
        The model's prose while it is producing it. Once the turn ends this text
        becomes the action summaries or the final answer, so it is only shown
        here during the turn itself.
      */}
      {answer.trim() && (
        <div className="border-t border-border/60 px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/90">
          {answer}
          {running && (
            <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-foreground/60 align-middle" />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A finished turn's reasoning, collapsed above the actions it produced.
 *
 * This is what the live box folds into: the same text, now part of the record
 * rather than transient. Default closed, because the actions are what most
 * reads are for — but one tap away, which is what makes the thinking auditable
 * after the fact instead of lost the moment it stops streaming.
 */
function TurnDisclosure({
  thinking,
  answer,
  actionCount,
  defaultOpen,
}: {
  thinking: string
  answer: string
  actionCount: number
  defaultOpen: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  if (!thinking.trim() && !answer.trim()) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left hover:bg-muted/40">
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <Brain className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">
          Thinking
          {actionCount > 0 && ` · ${actionCount} action${actionCount === 1 ? '' : 's'}`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 mb-1 overflow-hidden rounded-md border border-border bg-muted/30">
          {thinking.trim() && <ThinkingBox text={thinking} live={false} />}
          {answer.trim() && (
            <div className="border-t border-border/60 px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {answer}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/* -------------------------------------------------------------------------- */
/*  The timeline                                                               */
/* -------------------------------------------------------------------------- */


export function Timeline({
  session,
  className,
}: {
  session: AgentSessionState
  className?: string
}) {
  const { steps, status, messages } = session

  /*
   * Prompts and steps merged into one ordered list.
   *
   * Each prompt is placed immediately before the first step that came after it.
   * Timestamps rather than array positions, because the two are separate streams
   * — `messages` and `steps` — and position-in-array says nothing about order
   * across them. A prompt can also arrive with no steps after it yet, which is
   * the queued case, and it lands at the end where it belongs.
   */
  const entries = React.useMemo(() => {
    const prompts = messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ kind: 'prompt' as const, at: m.at, text: m.text, id: m.id }))
    const rows = steps.map((step) => ({ kind: 'step' as const, at: step.at, step }))
    return [...prompts, ...rows].sort((a, b) => a.at - b.at)
  }, [messages, steps])

  const endRef = React.useRef<HTMLDivElement>(null)
  const scroller = React.useRef<HTMLDivElement>(null)

  // Follow the newest step, but stop following the moment the user scrolls up —
  // yanking the viewport back while someone is reading earlier steps is worse
  // than letting them fall behind.
  const [follow, setFollow] = React.useState(true)
  const onScroll = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [])

  React.useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, follow])

  if (!entries.length) return null

  /*
   * Grouped for display: a turn's steps hang together under one collapsible
   * record of the reasoning that produced them, and prompts sit between the
   * groups as their own kind of row.
   */
  const items: (
    | { kind: 'prompt', id: string, text: string, at: number }
    | { kind: 'turn', turn: number, steps: Step[] }
  )[] = []
  {
    let current: Step[] = []
    const flush = () => {
      if (!current.length) return
      items.push({ kind: 'turn', turn: current[0].turn ?? 0, steps: current })
      current = []
    }
    for (const entry of entries) {
      if (entry.kind === 'prompt') {
        flush()
        items.push({ kind: 'prompt', id: entry.id, text: entry.text, at: entry.at })
      } else {
        current.push(entry.step)
      }
    }
    flush()
  }

  const lastTurn = [...items].reverse().find((i) => i.kind === 'turn')
  const newestTurn = lastTurn?.kind === 'turn' ? lastTurn.turn : -1
  const lastStepId = steps[steps.length - 1]?.id

  return (
    <div ref={scroller} onScroll={onScroll} className={cn('wp-scroll overflow-y-auto', className)}>
      <div className="py-1">
        {items.map((item) => {
          if (item.kind === 'prompt') {
            return <PromptRow key={`p-${item.id}`} text={item.text} at={item.at} />
          }

          const recorded = session.turns[item.turn]
          const actions = item.steps.filter((s) => s.kind !== 'read' && s.kind !== 'note')

          return (
            <div key={`turn-${item.turn}`} className="mb-0.5">
              {/*
                The turn's reasoning, above the actions it produced. For the turn
                currently streaming, the live box in the panel header is already
                showing it, so it is suppressed here to avoid saying it twice —
                and it appears the moment the turn finishes.
              */}
              {recorded && item.turn !== newestTurn && (
                <TurnDisclosure
                  thinking={recorded.thinking}
                  answer={recorded.answer}
                  actionCount={actions.length}
                  defaultOpen={false}
                />
              )}
              {item.steps.map((step) => (
                <StepRow key={step.id} step={step} last={step.id === lastStepId && status !== 'working'} />
              ))}
            </div>
          )
        })}

        {status === 'working' && (
          <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
            <span className="grid size-5 place-items-center">
              <CircleDashed className="size-3.5 animate-spin" />
            </span>
            <span className="text-[12px]">Working…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Status pill                                                                */
/* -------------------------------------------------------------------------- */

export function StatusPill({ status, note }: { status: string, note?: string }) {
  const spec: Record<
    string,
    { label: string, className: string, Icon: React.ComponentType<{ className?: string }> }
  > = {
    idle: { label: 'Ready', className: 'text-muted-foreground border-border', Icon: Square },
    working: { label: note || 'Working', className: 'text-running border-running/40 bg-running/10', Icon: CircleDashed },
    waiting: { label: note || 'Needs you', className: 'text-warn border-warn/40 bg-warn/10', Icon: Hand },
    done: { label: 'Finished', className: 'text-success border-success/40 bg-success/10', Icon: Check },
    error: { label: note || 'Problem', className: 'text-destructive border-destructive/40 bg-destructive/10', Icon: AlertCircle },
    stopped: { label: 'Stopped', className: 'text-muted-foreground border-border', Icon: X },
  }

  const s = spec[status] ?? spec.idle
  const Icon = s.Icon

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        s.className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', status === 'working' && 'animate-spin')} />
      <span className="truncate">{s.label}</span>
    </span>
  )
}