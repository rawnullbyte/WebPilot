import * as React from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from 'cn'

/**
 * How tall the input may grow before it scrolls instead.
 *
 * Sized in `rem` rather than pixels so it tracks the browser's text size, and
 * roughly a third of a phone screen: enough to read a long prompt back, not so
 * much that the transcript disappears behind it.
 */
const MAX_COMPOSER_HEIGHT_REM = 10
const MAX_COMPOSER_HEIGHT = MAX_COMPOSER_HEIGHT_REM * 16

/**
 * The task input.
 *
 * Enter sends, Shift+Enter makes a newline. On a phone the on-screen keyboard
 * reports Enter as a plain keypress, so the same rule holds without any special
 * casing — but the textarea stays multi-line because the useful prompts here are
 * the long ones, and a single-line input on mobile hides most of what you typed.
 */
export function Composer({
  onSubmit,
  onStop,
  running,
  disabled,
  placeholder,
  className,
}: {
  onSubmit: (text: string) => void
  onStop: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [value, setValue] = React.useState('')
  const ref = React.useRef<HTMLTextAreaElement>(null)

  /*
   * Grow with the content, but *only* once it actually overflows.
   *
   * The instinct is to set the height unconditionally on every change, which is
   * what this used to do — and it produced a box taller than the send button
   * even when empty, because an explicit pixel height was being locked in from
   * the first measurement instead of letting the stylesheet's `min-height`
   * govern. Clearing the height first and applying one only when the content
   * genuinely exceeds the box keeps the collapsed state exactly the height of
   * the button beside it.
   *
   * `field-sizing-content` on the Textarea already does this on engines that
   * support it; the measurement below is the fallback for those that do not.
   */
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = ''
    const needed = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)
    if (needed > el.clientHeight) el.style.height = `${needed}px`
  }, [value])

  /*
   * Sending is allowed while a task is running: it queues.
   *
   * Being told to wait for the current task before typing the next one means
   * holding it in your head and remembering to come back. Queueing captures it
   * at the moment you thought of it.
   */
  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    setValue('')
    onSubmit(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    // `items-end` keeps the button on the baseline as the box grows, so a
    // multi-line prompt does not leave it stranded at the top.
    <div className={cn('flex items-end gap-2', className)}>
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={disabled}
        placeholder={
          disabled
            ? (placeholder ?? 'Add your endpoint in Settings first')
            : running
              ? 'Type to queue a follow-up…'
              : (placeholder ?? 'Ask WebPilot to do something on this page…')
        }
        /* `h-9` matches the button's own height exactly — the two sit side by
           side, so any difference between them reads as a mistake. `py-0`
           with a `leading-9` line-height centres the text in that fixed
           height instead of padding it into a taller box. */
        className="h-9 min-h-9 resize-none px-3 py-0 text-[13px] leading-9"
      />
      {running ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Queue the current text, then a separate control to stop. */}
          {value.trim() && (
            <Button type="button" size="icon" onClick={submit} title="Queue this message">
              <ArrowUp className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="destructive"
            onClick={onStop}
            title="Stop"
            className="size-9 shrink-0"
          >
            <Square className="size-4 fill-current" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="icon"
          onClick={submit}
          disabled={!value.trim() || disabled}
          title="Send"
          className="size-9 shrink-0"
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
    </div>
  )
}