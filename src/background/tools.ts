/**
 * The tool surface exposed to the model.
 *
 * Kept deliberately small and flat. Every extra tool is another thing the model
 * can pick wrongly, and a browser has a small vocabulary of things you can
 * actually do to a page: look at it, click, type, choose, scroll, wait. Anything
 * beyond that (dragging, canvas gestures, file uploads) is deliberately absent —
 * it cannot be done reliably through the DOM, and pretending otherwise produces
 * an agent that fails in confusing ways instead of saying what it cannot do.
 *
 * `finish` is a tool rather than a stop condition because it gives the model
 * somewhere to put its answer. Waiting for plain prose is unreliable across
 * providers — many will narrate instead of concluding — whereas a required tool
 * argument is unambiguous.
 */

import type { ToolSchema } from './llm'

export const TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Get the current state of the page: its text and its numbered interactive elements. ' +
        'Call this first, and again after anything that changes the page — a click, a submit, ' +
        'a navigation, or a scroll. Element references from an earlier reading may be stale.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description:
        'Click an element. This is the main way to move around: links, buttons, menu items, ' +
        'tabs, checkboxes. Prefer clicking a questionable element over navigating to its URL, ' +
        'unless the URL is clearly right and the click is uncertain.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element reference from the page reading, e.g. "f0:n12".',
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description:
        'Type text into an input, textarea or contenteditable field. The field is focused first. ' +
        'Some pages reveal a login form or a search box only after you click something — if the ' +
        'field you need is not in the reading, look for the control that opens it.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference of the field, e.g. "f0:n7".' },
          text: { type: 'string', description: 'The text to enter.' },
          clear: {
            type: 'boolean',
            description: 'Replace the current contents instead of appending. Defaults to true.',
          },
          submit: {
            type: 'boolean',
            description: 'Press Enter after typing. Use for search boxes and login forms.',
          },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description:
        'Choose an option in a <select> dropdown. The available options are listed in the ' +
        "element's {options: …} hint when it has any.",
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference of the dropdown.' },
          value: {
            type: 'string',
            description: "The option's visible text or its value.",
          },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check',
      description:
        'Set a checkbox, radio button or switch to a specific state. Idempotent — asking for the ' +
        'state it is already in does nothing, so you can state your intent rather than toggling.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference of the checkbox or radio.' },
          checked: { type: 'boolean', description: 'true to tick it, false to untick it.' },
        },
        required: ['ref', 'checked'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description:
        'Move the pointer over an element. Use when a menu, tooltip or submenu only appears on ' +
        'hover, or when a click would be premature.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Element reference to hover.' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description:
        'Scroll the page. Use this to bring off-screen content into view, or to reach content ' +
        'that was cut off by the size limit, then call read_page.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: 'Which way to scroll.',
          },
          amount: {
            type: 'number',
            description: 'Pixels to scroll, for up and down. Defaults to most of a screen.',
          },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Press a single key on the focused element. Useful for Escape to close a dialog, Tab to ' +
        'move between fields, or Enter when no field is focused.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description:
        'Pause before looking again. Use sparingly, after an action you expect to be slow — ' +
        'a search, a payment step, a page that loads its content with JavaScript.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait, up to 10000.' },
        },
        required: ['ms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate',
      description:
        'Run JavaScript in the page and get the result back. This is the escape hatch for ' +
        'things the structured page tools cannot express: reading a table out of the DOM, ' +
        'pulling data from a data attribute, waiting on a condition, or calling the site\'s ' +
        'own JavaScript API.\n\n' +
        'The code runs with `await` available and its final expression is the result — ' +
        '`document.querySelectorAll("h2").length` returns the count. Returned DOM nodes and ' +
        'arrays of nodes come back as their HTML. `console.log` output is returned too.\n\n' +
        'Set `world: "MAIN"` only when you need the page\'s own globals (`window.someApp`, ' +
        '`jQuery`, a framework store). The default, ISOLATED, shares the DOM but not the ' +
        'page\'s JavaScript — it is safer, and it is enough for most work.\n\n' +
        'Prefer `click` and `type` when they will do. This tool bypasses the page\'s own ' +
        'event handling and will not reveal what the page does in response.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JavaScript to run. Runs inside an async function, so `await` works and the ' +
              'final expression is returned. Keep it focused — one question per call.',
          },
          world: {
            type: 'string',
            enum: ['ISOLATED', 'MAIN'],
            description:
              'ISOLATED (default) sees the DOM but not the page\'s globals. MAIN runs as the ' +
              'page would, so site globals are reachable — but the page can also see and ' +
              'interfere with your code.',
          },
          ref: {
            type: 'string',
            description:
              'Optional frame reference, e.g. "f3:n0". Runs the code in that element\'s frame ' +
              'instead of the top frame — use it to reach inside an iframe.',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user for one specific thing you cannot proceed without — a value only they ' +
        'know, a choice between two equally plausible paths, or confirmation that you have ' +
        'understood the task. Use it sparingly and only when you are genuinely blocked and a ' +
        'one-line answer unblocks you. It pauses until they reply. Do NOT use it to report ' +
        'progress, and do not use it to ask for a password, card number or other secret ' +
        'you can find another way to avoid needing. For anything that needs explaining, ' +
        'use finish instead.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The question, in one line, phrased so a short answer is enough. Say why you ' +
              'are asking if it is not obvious.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Call this when the task is complete, or when you are blocked and need the user. ' +
        'The summary is the answer the user reads — write it in plain language, and say what ' +
        'you found or what you need. Do not call it to report intermediate progress.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'What happened. Give the answer itself, not a description of the actions taken.',
          },
          success: {
            type: 'boolean',
            description: 'true if the task was completed, false if you are blocked.',
          },
        },
        required: ['summary'],
      },
    },
  },
]

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name))

/** Tools that change the page, and therefore its element references. */
export const MUTATING_TOOLS = new Set([
  'click',
  'type',
  'select_option',
  'check',
])

/* -------------------------------------------------------------------------- */
/*  Approval classification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Labels that suggest an action is hard to undo.
 *
 * This is a heuristic and is treated as one: it only ever *raises* the amount of
 * checking, never lowers it, so a miss means "no extra prompt" rather than "a
 * destructive action ran unchecked". Badly chosen words are a real risk here —
 * "Save" is usually benign while "Save and pay" is not — hence the multi-word
 * patterns before the single words.
 */
const IRREVERSIBLE_PATTERNS = [
  /\bpay\b/i, /\bpayment\b/i, /\bcheckout\b/i, /\bplace (your )?order\b/i,
  /\bbuy now\b/i, /\bpurchase\b/i, /\bconfirm (order|payment|purchase|booking)\b/i,
  /\bsubscribe\b/i, /\bupgrade to (pro|premium|plus)\b/i,
  /\bdelete\b/i, /\bremove (account|permanently)\b/i, /\bcancel (my )?(account|subscription|order)\b/i,
  /\bsend\b/i, /\bpost\b/i, /\bpublish\b/i, /\btweet\b/i, /\bshare\b/i,
  /\btransfer\b/i, /\bwithdraw\b/i, /\bdonate\b/i,
  /\bsign (out|off)\b/i, /\blog out\b/i, /\bunsubscribe\b/i, /\brevoke\b/i,
  /\bconfirm\b/i, /\bsubmit (application|order|payment)\b/i, /\bagree\b/i,
  /\baccept (terms|cookies|all)\b/i, /\bbook\b/i, /\breserve\b/i,
]

/** Concepts that mean the action involves money or identity — worth flagging. */
const SENSITIVE_CONTEXT = /\b(card|payment|billing|password|social security|ssn|cvv|bank|iban|routing)\b/i

export type RiskAssessment = {
  risky: boolean
  /** Shown to the user when the action is held for approval. */
  reason?: string
}

/**
 * Judges how much checking an action deserves.
 *
 * `risky` is only meaningful in the `risky` approval mode; in `auto` and
 * `always` the answer is ignored. It never blocks anything on its own — the
 * decision belongs to the user's configured mode.
 */
export function assessRisk(
  toolName: string,
  args: Record<string, unknown>,
  /** The name of the element being acted on, when there is one. */
  targetName?: string,
): RiskAssessment {
  const name = targetName ?? ''

  /*
   * Arbitrary code is always worth flagging in the "risky" mode, whatever it
   * says. There is no label to read and no button to recognise — the risk is
   * inherent to the capability, not to any particular snippet, and a
   * judgement about what a piece of JavaScript will do is exactly the judgement
   * a heuristic cannot make.
   */
  if (toolName === 'evaluate') {
    const world = args.world === 'MAIN' ? ' in the page’s own context' : ''
    return { risky: true, reason: `running JavaScript on the page${world}` }
  }

  if (toolName === 'type') {
    const text = String(args.text ?? '')
    if (SENSITIVE_CONTEXT.test(name)) {
      return { risky: true, reason: `typing into a field that looks like it holds ${name}` }
    }
    if (/\b(\d[ -]?){13,19}\b/.test(text.replace(/[\s-]/g, ''))) {
      return { risky: true, reason: 'the text looks like a card number' }
    }
    return { risky: false }
  }

  if (toolName === 'click') {
    for (const pattern of IRREVERSIBLE_PATTERNS) {
      const m = pattern.exec(name)
      if (m) return { risky: true, reason: `"${name}" looks irreversible` }
    }
    if (SENSITIVE_CONTEXT.test(name)) {
      return { risky: true, reason: `"${name}" relates to payment or credentials` }
    }
    return { risky: false }
  }

  return { risky: false }
}

/**
 * Whether a navigation leaves the site the task started on. Used as a warning
 * signal in `risky` mode: following a link off-site is usually fine, but a
 * *submit* that posts credentials somewhere new is worth a look.
 */
export function isCrossSite(from: string, to: string): boolean {
  try {
    const a = new URL(from)
    const b = new URL(to)
    const registrable = (host: string) => host.split('.').slice(-2).join('.')
    return registrable(a.hostname) !== registrable(b.hostname)
  } catch {
    return false
  }
}

export type ToolAvailability = {
  /** Whether anything can render a question and collect an answer. */
  canAsk: boolean
  /**
   * Whether the user has allowed arbitrary JavaScript in pages.
   *
   * `evaluate` is a genuinely different kind of capability from the rest: it is
   * not "act on this page" but "run my code in this page", which can read
   * anything the page can and call anything it can. It is off unless the user
   * turns it on, so the model is never offered a tool that will refuse.
   */
  allowScripting: boolean
}

/**
 * The tools actually offered to the model.
 *
 * Withholding a tool is better than offering one that fails: a model given
 * `ask_user` with no panel to render a question into will call it, stall, and
 * conclude the task is impossible — where without it, it would simply have made
 * a decision and carried on.
 */
export function toolsFor(availability: ToolAvailability): ToolSchema[] {
  return TOOLS.filter((tool) => {
    const name = tool.function.name
    if (name === 'ask_user') return availability.canAsk
    if (name === 'evaluate') return availability.allowScripting
    return true
  })
}

/** What to show the user when asking them to approve an action. */
export function describeAction(toolName: string, args: Record<string, unknown>, targetName?: string): string {
  const name = targetName ? `"${targetName}"` : 'the page'
  switch (toolName) {
    case 'click': return `Click ${name}`
    case 'type': return `Type into ${name}`
    case 'select_option': return `Choose "${String(args.value)}" in ${name}`
    case 'check': return `${args.checked ? 'Tick' : 'Untick'} ${name}`
    case 'hover': return `Hover over ${name}`
    case 'scroll': return `Scroll ${String(args.direction)}`
    case 'press_key': return `Press ${String(args.key)}`
    case 'wait': return `Wait ${String(args.ms)} ms`
    default: return `Run ${toolName}`
  }
}