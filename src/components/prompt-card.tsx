import * as React from 'react'
import { AlertTriangle, HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PendingPrompt } from '@/components/use-panel'

/**
 * What the agent shows when it stops and waits for a person.
 *
 * Two cases, both of which block a run:
 *
 *  - **Approval.** Only reachable in the `risky` or `always` modes; in `auto`
 *    the agent never asks. Rendered as a decision, not a notification, because
 *    the run is genuinely suspended until it is answered — and a declined action
 *    is reported back to the model so it can try another way rather than retry.
 *
 *  - **Question.** The agent hit something it cannot decide alone: which of two
 *    similar search results, a missing value it refuses to invent, or a captcha
 *    it will not attempt.
 */
export function PromptCard({
  prompt,
  onAnswer,
  onApprove,
}: {
  prompt: PendingPrompt
  onAnswer: (id: string, answer: string) => void
  onApprove: (id: string, approved: boolean) => void
}) {
  if (prompt.kind === 'approval') {
    return (
      <div className="mx-3 mb-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
        <div className="mb-2 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">{prompt.action}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{prompt.reason}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => onApprove(prompt.id, true)}>
            Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => onApprove(prompt.id, false)}
          >
            Skip
          </Button>
        </div>
      </div>
    )
  }

  return <QuestionCard prompt={prompt} onAnswer={onAnswer} />
}

function QuestionCard({
  prompt,
  onAnswer,
}: {
  prompt: Extract<PendingPrompt, { kind: 'question' }>
  onAnswer: (id: string, answer: string) => void
}) {
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="mx-3 mb-2 rounded-lg border border-running/40 bg-running/5 p-3">
      <div className="mb-2 flex items-start gap-2">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-running" />
        <p className="text-[13px] leading-snug">{prompt.text}</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(prompt.id, value)
        }}
      >
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your answer…"
          className="h-8 text-[13px]"
        />
        <Button size="sm" type="submit">
          Send
        </Button>
      </form>
    </div>
  )
}