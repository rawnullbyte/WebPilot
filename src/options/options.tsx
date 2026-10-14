import * as React from 'react'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { BrandMark } from '@/components/panel'
import { panelClient } from '@/components/use-panel'
import { DEFAULT_SYSTEM_PROMPT, normalizeEndpoint } from '@/shared/settings'
import type { ApprovalMode, Settings } from '@/shared/types'

/* -------------------------------------------------------------------------- */
/*  Presets                                                                    */
/* -------------------------------------------------------------------------- */

const PRESETS: { name: string, endpoint: string, hint: string }[] = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', hint: 'Your OpenAI key' },
  { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', hint: 'One key, many models' },
  { name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', hint: 'Fast, free tier' },
  { name: 'Together', endpoint: 'https://api.together.xyz/v1', hint: 'Open-weight models' },
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', hint: 'Cheap and capable' },
  { name: 'Ollama (local)', endpoint: 'http://localhost:11434/v1', hint: 'Runs on this machine' },
  { name: 'LM Studio (local)', endpoint: 'http://localhost:1234/v1', hint: 'Runs on this machine' },
]

const APPROVAL_MODES: { value: ApprovalMode, label: string, description: string, icon: React.ComponentType<{ className?: string }> }[] = [
  {
    value: 'auto',
    label: 'Act freely',
    description: 'Never ask. Fastest, and the default.',
    icon: Zap,
  },
  {
    value: 'risky',
    label: 'Ask when risky',
    description: 'Act freely, but pause for anything that looks irreversible — submits, payments, deletions, sending.',
    icon: ShieldAlert,
  },
  {
    value: 'always',
    label: 'Ask every time',
    description: 'Confirm every click and every keystroke group before it happens.',
    icon: Eye,
  },
]

/* -------------------------------------------------------------------------- */

export function Options() {
  const client = React.useMemo(() => panelClient(), [])
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [showKey, setShowKey] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ ok: boolean, message: string } | null>(null)
  const [models, setModels] = React.useState<string[]>([])
  const [loadingModels, setLoadingModels] = React.useState(false)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    // The options page is a normal document; it still talks over the same port
    // so it sees settings changes made anywhere else.
    client.connect('popup', null)
    client.getSettings().then(setSettings).catch(() => {})
  }, [client])

  const update = React.useCallback(
    (patch: Partial<Settings>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
      setSaved(false)
      client
        .saveSettings(patch)
        .then(() => {
          setSaved(true)
          window.setTimeout(() => setSaved(false), 1600)
        })
        .catch(() => {})
    },
    [client],
  )

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await client.request<{ ok: boolean, message: string }>({ type: 'settings/test' })
      setTestResult(res)
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async () => {
    setLoadingModels(true)
    try {
      const res = await client.request<{ ok: boolean, models: string[], error?: string }>({
        type: 'settings/models',
      })
      setModels(res.models ?? [])
      if (!res.ok && res.error) setTestResult({ ok: false, message: res.error })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoadingModels(false)
    }
  }

  if (!settings) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const configured = Boolean(settings.endpoint && settings.model)

  return (
    <div className="min-h-dvh bg-muted/30">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        {/* -------------------------------------------------------------- */}
        <header className="mb-6 flex items-center gap-3">
          <BrandMark className="size-7 text-running" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">WebPilot</h1>
            <p className="text-[13px] text-muted-foreground">
              Point it at any OpenAI-compatible endpoint, then let it work the page.
            </p>
          </div>
          {saved && (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="size-3" /> Saved
            </Badge>
          )}
        </header>

        <div className="space-y-4">
          {/* ------------------------------------------------------------ */}
          {/* Model                                                         */}
          {/* ------------------------------------------------------------ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Model</CardTitle>
              <CardDescription>
                Your key is stored on this device only and sent straight to the endpoint you
                name — WebPilot has no server.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="endpoint">Base URL</Label>
                <Input
                  id="endpoint"
                  value={settings.endpoint}
                  onChange={(e) => update({ endpoint: e.target.value })}
                  onBlur={(e) => {
                    const normalized = normalizeEndpoint(e.target.value)
                    if (normalized !== e.target.value) update({ endpoint: normalized })
                  }}
                  placeholder="https://api.openai.com/v1"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[13px]"
                />
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      title={p.hint}
                      onClick={() => update({ endpoint: p.endpoint })}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        normalizeEndpoint(settings.endpoint) === p.endpoint
                          ? 'border-running/50 bg-running/10 text-running'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="apiKey">API key</Label>
                <div className="flex gap-2">
                  <Input
                    id="apiKey"
                    type={showKey ? 'text' : 'password'}
                    value={settings.apiKey}
                    onChange={(e) => update({ apiKey: e.target.value })}
                    placeholder="sk-…"
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono text-[13px]"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Not needed for most local servers. Leave it blank if yours does not check.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="model">Model</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={fetchModels}
                    disabled={loadingModels || !settings.endpoint}
                    className="text-muted-foreground"
                  >
                    {loadingModels ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    Load list
                  </Button>
                </div>
                <Input
                  id="model"
                  value={settings.model}
                  onChange={(e) => update({ model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  spellCheck={false}
                  autoComplete="off"
                  list={models.length ? 'wp-models' : undefined}
                  className="font-mono text-[13px]"
                />
                {models.length > 0 && (
                  <>
                    <datalist id="wp-models">
                      {models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <ScrollArea className="wp-scroll max-h-28 rounded-md border">
                      <div className="flex flex-wrap gap-1.5 p-2">
                        {models.slice(0, 200).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => update({ model: m })}
                            className={cn(
                              'rounded border px-2 py-0.5 font-mono text-[11px] transition-colors',
                              settings.model === m
                                ? 'border-running/50 bg-running/10 text-running'
                                : 'border-border text-muted-foreground hover:bg-accent',
                            )}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                    <p className="text-[11px] text-muted-foreground">
                      {models.length} model{models.length === 1 ? '' : 's'} available.
                    </p>
                  </>
                )}
                <p className="text-[11px] text-muted-foreground">
                  WebPilot needs a model that supports function calling. Small local models
                  often do not — the test below will tell you.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={test} disabled={testing || !settings.endpoint || !settings.model}>
                  {testing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  Test connection
                </Button>
                {testResult && (
                  <div
                    className={cn(
                      'flex-1 rounded-md border px-2.5 py-1.5 text-[12px] leading-snug',
                      testResult.ok
                        ? 'border-success/40 bg-success/5 text-success'
                        : 'border-destructive/40 bg-destructive/5 text-destructive',
                    )}
                  >
                    {testResult.message}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------------------------------------ */}
          {/* Behaviour                                                     */}
          {/* ------------------------------------------------------------ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Behaviour</CardTitle>
              <CardDescription>How much the agent does on its own, and how far it goes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Before acting</Label>
                <div className="grid gap-2">
                  {APPROVAL_MODES.map((mode) => {
                    const Icon = mode.icon
                    const active = settings.approval === mode.value
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={() => update({ approval: mode.value })}
                        className={cn(
                          'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                          active
                            ? 'border-running/50 bg-running/5'
                            : 'border-border hover:bg-accent/60',
                        )}
                      >
                        <Icon className={cn('mt-0.5 size-4 shrink-0', active ? 'text-running' : 'text-muted-foreground')} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium">{mode.label}</p>
                          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                            {mode.description}
                          </p>
                        </div>
                        {active && <CheckCircle2 className="ml-auto size-4 shrink-0 text-running" />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <Separator />

              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  id="maxSteps"
                  label="Maximum actions per task"
                  value={settings.maxSteps}
                  min={1}
                  max={200}
                  hint="The agent stops here even if it has not finished."
                  onChange={(v) => update({ maxSteps: v })}
                />
                <NumberField
                  id="temperature"
                  label="Temperature"
                  value={settings.temperature}
                  min={0}
                  max={2}
                  step={0.1}
                  hint="Low keeps it focused on the task. 0–0.3 is usually right."
                  onChange={(v) => update({ temperature: v })}
                />
                <NumberField
                  id="rateLimit"
                  label="Requests per minute"
                  value={settings.rateLimit}
                  min={0}
                  max={600}
                  hint="Set to 0 for no limit. Guards a local model from being hammered."
                  onChange={(v) => update({ rateLimit: v })}
                />
                <div className="space-y-3">
                  <ToggleRow
                    id="showThinking"
                    label="Show thinking"
                    description="Streams the model's reasoning into the panel as it works. Only models that report it will show anything."
                    checked={settings.showThinking}
                    onChange={(v) => update({ showThinking: v })}
                  />
                  <ToggleRow
                    id="vision"
                    label="Send screenshots"
                    description="Attaches a labelled picture each step. Needs a vision model, and costs far more per step."
                    checked={settings.vision}
                    onChange={(v) => update({ vision: v })}
                  />
                  <ToggleRow
                    id="allowScripting"
                    label="Allow JavaScript in pages"
                    description="Adds an evaluate tool so the agent can run its own code in a page — reading the DOM directly, or calling the site's own APIs. This is far more powerful than clicking and typing, and can read anything the page can."
                    checked={settings.allowScripting}
                    onChange={(v) => update({ allowScripting: v })}
                    warn
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------------------------------------ */}
          {/* Advanced                                                      */}
          {/* ------------------------------------------------------------ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Advanced</CardTitle>
              <CardDescription>
                For endpoints that deviate from the OpenAI schema.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="headers">Extra request headers</Label>
                <Textarea
                  id="headers"
                  value={settings.extraHeaders}
                  onChange={(e) => update({ extraHeaders: e.target.value })}
                  rows={3}
                  spellCheck={false}
                  placeholder={'HTTP-Referer: https://example.com\nX-Title: WebPilot'}
                  className="font-mono text-[12px]"
                />
                <p className="text-[11px] text-muted-foreground">
                  One <code className="font-mono">Name: value</code> per line. Some gateways
                  want attribution headers.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="systemPrompt">Instructions</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => update({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
                  >
                    Reset to default
                  </Button>
                </div>
                <Textarea
                  id="systemPrompt"
                  value={settings.systemPrompt}
                  onChange={(e) => update({ systemPrompt: e.target.value })}
                  rows={8}
                  spellCheck={false}
                  className="font-mono text-[12px] leading-relaxed"
                />
                <p className="text-[11px] text-muted-foreground">
                  The agent's standing instructions. Editing this changes how it behaves on
                  every page — worth reading once before you rely on it.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------------------------------------ */}
          {/* How it works                                                  */}
          {/* ------------------------------------------------------------ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How it works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[12px] leading-relaxed text-muted-foreground">
              <p>
                On each step WebPilot sends your model a description of the page: its visible
                text, and every interactive element with a reference like{' '}
                <code className="font-mono text-foreground">f0:n12</code>. The model replies by
                calling a tool — click, type, scroll, and so on — and WebPilot performs it and
                reports back what happened.
              </p>
              <p>
                Embedded frames are read too. A form inside an iframe is its own document, so it
                gets its own prefix, which is why a reference may read{' '}
                <code className="font-mono text-foreground">f3:n4</code>. The agent treats
                them all as one page.
              </p>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="mb-1 font-medium text-foreground">What it will not do</p>
                <p>
                  It refuses captchas, login walls and payment steps rather than trying to get
                  around them, and it will not invent credentials or personal details — it only
                  uses what you tell it. If it cannot finish, it says so instead of clicking
                  around hopefully.
                </p>
              </div>
              <p>
                Your key and your pages stay on this device. Requests go only to the endpoint
                you configured.
              </p>
            </CardContent>
          </Card>

          <p className="pb-4 text-center text-[11px] text-muted-foreground">
            {configured ? 'Ready.' : 'Add a base URL and a model name to get started.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  warn,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  /** Draws attention to a setting that grants a broad capability. */
  warn?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border p-3',
        warn && checked && 'border-warn/40 bg-warn/5',
      )}
    >
      <div className="min-w-0">
        <Label htmlFor={id} className="text-[13px]">
          {label}
        </Label>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  hint?: string
  onChange: (value: number) => void
}) {
  // Kept as a string while editing so a half-typed number is not clamped
  // out from under the cursor.
  const [draft, setDraft] = React.useState(String(value))
  React.useEffect(() => setDraft(String(value)), [value])

  const commit = (raw: string) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(Math.max(parsed, min), max)
    setDraft(String(clamped))
    onChange(clamped)
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px]">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        className="text-[13px]"
      />
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}