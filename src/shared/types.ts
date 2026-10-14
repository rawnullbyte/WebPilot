/**
 * The contract shared by every part of WebPilot: the content scripts that read
 * and drive a page, the background agent loop, and both UI surfaces.
 *
 * Nothing here may import browser APIs — this file is loaded in the page, in
 * the background, and in React panels alike.
 */

/* -------------------------------------------------------------------------- */
/*  Settings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much the agent checks in before it touches a page.
 *
 * `auto`   — act freely, never ask. Fastest; pick this when you are watching.
 * `risky`  — act freely, but pause for anything that looks irreversible
 *            (form submits, destructive-looking labels, leaving the site).
 * `always` — pause for every single action.
 */
export type ApprovalMode = 'auto' | 'risky' | 'always'

export type Settings = {
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  endpoint: string
  apiKey: string
  model: string
  temperature: number
  /** Hard ceiling on agent steps before it gives up. */
  maxSteps: number
  approval: ApprovalMode
  /**
   * Whether to attach a screenshot of the page (with interactive elements
   * outlined and numbered) to each step. Off means text-only, which is far
   * cheaper and works with any model.
   */
  vision: boolean
  systemPrompt: string
  /** Extra request headers, one `Name: value` per line. */
  extraHeaders: string
  /**
   * Stream the model's reasoning into the panel as it is produced.
   *
   * Off by default. It is genuinely useful — a long pause you can read is far
   * less worrying than a long pause you cannot — but it also means every token
   * of the model's scratch work is held in memory and rendered, which is real
   * cost on a phone.
   */
  showThinking: boolean
  /**
   * Allow the agent to run arbitrary JavaScript in pages.
   *
   * Off by default. This is a different order of capability from clicking and
   * typing: it can read anything the page can read and call anything the page
   * can call. `evaluate` is withheld from the model entirely while this is off.
   */
  allowScripting: boolean
  /** Requests per minute ceiling; guards against hammering a local model. */
  rateLimit: number
}

/* -------------------------------------------------------------------------- */
/*  Page model                                                                 */
/* -------------------------------------------------------------------------- */

export type Rect = { x: number, y: number, w: number, h: number }

export type ViewportInfo = {
  scrollX: number
  scrollY: number
  innerWidth: number
  innerHeight: number
  scrollWidth: number
  scrollHeight: number
  /** Device pixel ratio, so the agent knows how a screenshot maps to CSS px. */
  dpr: number
}

/**
 * One interactive thing on the page. `id` is stable only within a single
 * snapshot of a single frame — after the page mutates, refs are re-issued.
 */
export type PageNode = {
  id: string
  /** button, link, textbox, checkbox, radio, combobox, menuitem, tab, … */
  role: string
  /** Accessible name, falling back to visible text. */
  name: string
  /** Current value, for inputs and selects. */
  value?: string
  /** disabled, checked, required, readonly, expanded, selected, … */
  state?: string[]
  href?: string
  /** Whether any part of the element is inside the viewport right now. */
  inView: boolean
  /**
   * The element's box in *page* coordinates — the same space as `scrollX`/
   * `scrollY`, so it stays valid regardless of where the page is scrolled.
   * Used to draw the numbered overlay onto a screenshot.
   */
  rect?: Rect
  /** Present for grouped containers so the tree reads like the page looks. */
  children?: PageNode[]
  /** e.g. "search box", "login form", used as a hint when the name is vague. */
  hint?: string
  /** The text around the control, which often names it better than the label. */
  context?: string
}

export type FrameRead = {
  frameId: number
  url: string
  title: string
  /** Rendered area is essentially nothing — an analytics or tracking iframe. */
  hidden: boolean
  viewport: ViewportInfo
  /** Visible text, whitespace-collapsed. */
  text: string
  nodes: PageNode[]
  /** True when text or node count hit the frame's budget. */
  truncated: boolean
}

export type Snapshot = {
  url: string
  title: string
  viewport: ViewportInfo
  frames: FrameRead[]
  /** Element outlines drawn onto the screenshot, in page coordinates. */
  marks: (Rect & { ref: string })[]
  truncated: boolean
}

/* -------------------------------------------------------------------------- */
/*  Agent transcript                                                           */
/* -------------------------------------------------------------------------- */

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error' | 'stopped'

/** A single thing the agent did, rendered as a row in the timeline. */
export type Step = {
  id: string
  /**
   * Which model turn produced this step.
   *
   * One turn is one request to the model and the actions it asked for, so this
   * is the grouping the transcript uses: the reasoning that led to a set of
   * actions belongs with those actions, not repeated against each one.
   */
  turn: number
  index: number
  at: number
  kind: 'read' | 'act' | 'navigate' | 'answer' | 'error' | 'note'
  /** One line, already human-readable: `Clicking "Sign in"`. */
  title: string
  /** Secondary line: the resolved element, the value typed, the error. */
  detail?: string
  /** Tool arguments, kept for the expanded view. */
  args?: unknown
  /** Tool result, kept for the expanded view. */
  result?: string
  /**
   * The model's reasoning immediately before this step, when it reported any.
   *
   * Attached rather than discarded so the thinking stays readable after the fact:
   * live streaming shows what is happening now, but a live box alone loses it the
   * moment the next step arrives, which is exactly when you want to re-read it.
   */
  thinking?: string
  ok?: boolean
  durationMs?: number
}

export type AgentEvent =
  | { kind: 'status', status: AgentStatus, note?: string }
  | { kind: 'message', message: ChatMessage }
  | { kind: 'step', step: Step }
  | { kind: 'cleared' }
  /**
   * A chunk of text the model is producing right now, for live rendering.
   *
   * Kept separate from `step` and `message` because it is high-frequency and
   * transient: it is sent once per token, it never belongs in the persisted
   * transcript, and it is replaced by a real step or message the moment the turn
   * completes.
   */
  | { kind: 'stream', stream: { id: string, text: string, done: boolean } }

export type AgentSessionState = {
  status: AgentStatus
  messages: ChatMessage[]
  steps: Step[]
  /** Set while the agent is blocked on a user answer. */
  question: { id: string, text: string } | null
  /**
   * Set while the agent is blocked on approval for one action.
   *
   * Recorded on the session rather than only held in the pending-promise map so
   * that a panel connecting *after* the prompt was raised can still render and
   * answer it. Without that, a prompt raised while the overlay was still loading
   * would be shown to nobody and would time out into a refusal.
   */
  approval: { id: string, action: string, reason: string } | null
  /** Which tab the running agent belongs to. */
  tabId: number | null
  /**
   * Text the model is producing right now, keyed by the kind of text.
   *
   * `thinking` is its reasoning, `answer` is its prose before it acts. Both are
   * cleared as soon as the turn ends or the agent takes a step, so this only
   * ever holds what is happening *now*.
   */
  stream: { thinking: string, answer: string }
  /**
   * Reasoning and prose already completed, keyed by turn number.
   *
   * Kept so the transcript can show a finished turn's reasoning as an expandable
   * disclosure above the actions it produced — the way the live box folds away
   * into the record once it stops streaming, rather than disappearing along with
   * the tokens.
   */
  turns: Record<number, { thinking: string, answer: string }>
  note?: string
}

/* -------------------------------------------------------------------------- */
/*  Operations the agent can perform                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every op is addressed to one frame. `ref` is `n12` within that frame; the
 * background splits the `f0:n12` form into `frameId` + `ref`.
 */
export type AgentOp =
  | { op: 'click', ref: string }
  | { op: 'type', ref: string, text: string, clear?: boolean, submit?: boolean }
  | { op: 'select', ref: string, value: string }
  | { op: 'hover', ref: string }
  | { op: 'check', ref: string, checked: boolean }
  | { op: 'focus', ref: string }
  | { op: 'key', key: string, ref?: string }
  | { op: 'scroll', direction: 'up' | 'down' | 'top' | 'bottom', amount?: number, ref?: string }
  | { op: 'read' }
  | { op: 'wait', ms: number }

export type OpResult = {
  ok: boolean
  /** What happened, phrased for the model: `Clicked "Sign in".` */
  message: string
  /** Present when the op changed the page enough to invalidate refs. */
  navigated?: boolean
  /** Set when the op failed and the model should reconsider. */
  error?: string
  /** Fresh snapshot, only returned for `read`. */
  snapshot?: Snapshot
}

/* -------------------------------------------------------------------------- */
/*  Messaging                                                                  */
/* -------------------------------------------------------------------------- */

export type UiSurface = 'sidebar' | 'overlay' | 'popup'

/** Panel → background. */
export type BgRequest =
  | { type: 'agent/run', prompt: string }
  | { type: 'agent/stop' }
  | { type: 'agent/answer', id: string, answer: string }
  | { type: 'agent/approve', id: string, approved: boolean }
  | { type: 'agent/clear' }
  | { type: 'agent/state' }
  | { type: 'settings/get' }
  | { type: 'settings/set', patch: Partial<Settings> }
  | { type: 'settings/test' }
  | { type: 'settings/models' }
  | { type: 'ui/register', surface: UiSurface }
  | { type: 'ui/open-overlay' }
  | { type: 'ui/close-overlay' }
  | { type: 'ui/toggle-overlay' }
  /** Which panel surface this browser actually has. */
  | { type: 'ui/which-surface' }
  /** Open whichever panel surface is available. */
  | { type: 'ui/open-panel' }

/** Background → content frame. */
export type FrameRequest =
  | { type: 'frame/exec', op: AgentOp, frameId: number, budget?: Partial<ReadBudget> }
  | { type: 'frame/read', budget?: Partial<ReadBudget> }
  | {
      type: 'frame/highlight'
      on: boolean
      /** Refs to box. Usually one — the element being acted on. */
      refs?: string[]
      /** Pulse them briefly, to make the action visible as it happens. */
      flash?: boolean
    }
  | {
      type: 'frame/annotate'
      dataUrl: string
      marks: (Rect & { ref: string })[]
      viewportWidth: number
    }

/** Content frame → background, on load. */
export type FrameReady = { type: 'frame/ready', top: boolean, url: string }

export type ReadBudget = {
  maxText: number
  maxNodes: number
  maxDepth: number
}

/** Background → panel. */
export type BgEvent =
  | { type: 'agent/event', event: AgentEvent }
  /**
   * Full state, sent when a panel connects or asks for it.
   *
   * Carries the tab it describes, because the panel has to be able to tell a
   * snapshot for its own tab (replace what is shown) from one for another tab or
   * from a stale race (ignore it). Without that distinction a snapshot arriving
   * mid-run blanks a live transcript, which is what "it randomly resets to a
   * fresh chat while working" turned out to be.
   */
  | { type: 'agent/state', tabId: number | null, session: AgentSessionState }
  /** The agent paused and is blocked on a yes/no about one action. */
  | { type: 'agent/approval', id: string, action: string, reason: string }
  /** The agent needs free-text input from the user. */
  | { type: 'agent/question', id: string, text: string }
  | { type: 'ui/close' }

/** Background → panel, answering a request made over the same port. */
export type PortReply = { type: 'reply', id: string, result: unknown }

export type TestResult = {
  ok: boolean
  message: string
  /** Models reported by the endpoint when it supports listing. */
  models?: string[]
  latencyMs?: number
}