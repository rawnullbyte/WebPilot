/**
 * WebPilot's frame agent.
 *
 * This runs once per frame — including cross-origin iframes, because the
 * manifest declares `all_frames: true`. Each frame answers for itself: it can
 * describe its own interactive elements, and it can act on them. The background
 * stitches the frames together into one page model, which is why an agent
 * working on WebPilot can reach a form inside an embedded iframe.
 *
 * Nothing here runs until the background sends a message, so the cost on a
 * page nobody is driving is one idle listener.
 */

import type {
  AgentOp,
  FrameRead,
  OpResult,
  PageNode,
  ReadBudget,
  ViewportInfo,
} from '@/shared/types'

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_BUDGET: ReadBudget = {
  maxText: 12_000,
  maxNodes: 400,
  maxDepth: 15,
}

/**
 * Elements the agent can address. Deliberately broad: modern pages put click
 * handlers on plain `<div>`s, so `[role]`/`[tabindex]`/`[onclick]` catch the
 * ones that are not natively interactive.
 *
 * The landmark tags at the end are here so the page's structure survives the
 * read — a form groups its fields, a nav groups its links. `label[for]` is
 * deliberately *absent*: a label is not separately actionable, and including it
 * would list every form field twice, once as the label and once as the input
 * that already takes its name from it.
 */
const CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  '[role]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  /*
   * A `<label>` is how a great many quizzes, surveys and preference screens put
   * their choices on screen: a styled div next to a visually-hidden radio. The
   * label is the only part with content, and clicking it is the only way to
   * choose — so it is a first-class control, not decoration.
   *
   * An earlier version of this list excluded labels to avoid listing every field
   * twice. That was wrong for non-text controls, where the input is either
   * visually hidden or absent altogether, and it is what made a quiz frame look
   * like it had no interactive elements at all.
   */
  'label[for]',
  'label',
  'audio[controls]',
  'video[controls]',
  'form',
  'fieldset',
  'dialog',
  'nav',
  'main',
].join(',')

/** Roles that mean "this container groups other controls", not "click me". */
const CONTAINER_ROLES = new Set([
  'form', 'navigation', 'main', 'banner', 'contentinfo', 'complementary',
  'region', 'search', 'list', 'table', 'grid', 'group', 'menu', 'menubar',
  'tablist', 'toolbar', 'dialog', 'alertdialog', 'article', 'directory',
  'radiogroup', 'treegrid', 'feed', 'figure', 'figurecaption',
  'rowgroup', 'row', 'columnheader', 'rowheader',
  /*
   * `listbox` is deliberately absent even though it is structural. It is also
   * the role a `<select multiple>` gets, and a container role makes
   * `select_option` silently do nothing — the option is never found in the
   * container's children because options are not nodes. Leaving it out means a
   * multi-select reads as one flat element, which is what it is.
   */
])

/** Tags whose text content is never visible prose. */
const SKIP_TEXT_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG',
  'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'MAP', 'AREA',
])

/* -------------------------------------------------------------------------- */
/*  Ref registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `n12` → element, valid only for the most recent read of this frame.
 *
 * Refs are re-issued on every read rather than held stable across page
 * mutations: any attempt to track identity through arbitrary framework re-renders
 * ends up pointing at recycled nodes, and a confidently wrong ref is worse than
 * an honest "read the page again". Actions therefore verify the element is
 * still connected and say so plainly when it is not.
 */
let registry = new Map<string, Element>()
let registryUrl = location.href

function resetRegistry() {
  registry = new Map()
}

function resolveRef(ref: string): { el: Element | null, error?: string } {
  if (registryUrl !== location.href) {
    return {
      el: null,
      error: 'The page navigated since the last reading, so that reference is stale.',
    }
  }
  const el = registry.get(ref)
  if (!el) {
    return {
      el: null,
      error: `Unknown reference "${ref}". Read the page again to get current references.`,
    }
  }
  if (!el.isConnected) {
    return {
      el: null,
      error: `The element "${ref}" is no longer on the page. Read the page again.`,
    }
  }
  return { el }
}

/* -------------------------------------------------------------------------- */
/*  Visibility and naming                                                      */
/* -------------------------------------------------------------------------- */

function isOurs(el: Element): boolean {
  return Boolean(el.closest('[data-webpilot-ui]'))
}

/**
 * Visible enough to be worth showing the model.
 *
 * `display:none`/`visibility:hidden` are decisive. Zero size is not, on its own:
 * some frameworks render controls as `width:0` right up until an animation
 * finishes, and a button that is about to appear is still worth knowing about —
 * so a zero-size hit is only treated as hidden when it is also clipped or
 * `opacity:0`.
 */
function isVisible(el: Element): boolean {
  if (!el.isConnected) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (style.opacity === '0' && style.pointerEvents === 'none') return false
  if (el.hasAttribute('hidden')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false

  const rect = el.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) return true

  // Zero-sized: hidden only if something actually clips it away.
  const clip = style.clipPath ?? ''
  if (clip && clip !== 'none') return false
  if (/(rect\(0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\))/.test(style.clip ?? '')) return false
  if (style.overflow === 'hidden' && rect.width === 0 && rect.height === 0) return false
  return false
}

/** Whether any part of the element is inside the frame's viewport. */
function isInView(rect: DOMRect): boolean {
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

/**
 * The `for`/wrapping label, which is the best name for a form field.
 *
 * Nothing is stripped from the label's text. An `<input>` contributes no text
 * node of its own, so its value never appears in the label's `textContent` — and
 * attempting to remove it anyway corrupts the name, because the value is a bare
 * substring that can occur inside a real word (a checkbox's default value is
 * "on", which turns "Free cancellation only" into "Free cancellati only").
 */
function labelFor(el: Element): string {
  const id = el.getAttribute('id')
  if (id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (explicit?.textContent) return clean(explicit.textContent)
  }
  const wrapping = el.closest('label')
  if (wrapping?.textContent) return clean(wrapping.textContent)
  return ''
}

function clean(s: string, max = 160): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * A pragmatic accessible-name computation, following the parts of the spec that
 * matter here. It is not a complete implementation — slots, CSS-generated
 * content and SVG `<title>` are all missing — but it orders its sources the way
 * the spec does, which is what makes the result match what a screen-reader user
 * would call the control.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .filter(Boolean)
    if (parts.length) return clean(parts.join(' '))
  }

  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel?.trim()) return clean(ariaLabel)

  const tag = el.tagName.toLowerCase()

  /*
   * An element with no content model is named by its label *before* its text,
   * which matters for `<select>`: its `textContent` is every option concatenated,
   * so reading text first names a country picker "Australia Brazil Canada" and
   * hides the field's actual label entirely.
   */
  const isVoid = tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'img'
  if (isVoid) {
    const fromLabel = labelFor(el)
    if (fromLabel) return fromLabel
  }

  // Buttons, links and other containers: their content is their name.
  const text = clean(el.textContent ?? '')
  if (text) return text

  const fromLabel = isVoid ? '' : labelFor(el)
  if (fromLabel) return fromLabel

  if (el instanceof HTMLInputElement) {
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') {
      if (el.value) return clean(el.value)
    }
    if (el.placeholder) return clean(el.placeholder)
    if (el.type === 'image' && el.alt) return clean(el.alt)
  }
  if (el instanceof HTMLImageElement && el.alt) return clean(el.alt)

  const title = el.getAttribute('title')
  if (title?.trim()) return clean(title)

  const name = el.getAttribute('name')
  if (name?.trim()) return clean(name)

  // Nothing at all: fall back to a description of the thing itself.
  if (el instanceof HTMLInputElement && el.type !== 'text') {
    return `<${el.type} input>`
  }
  return `<${el.tagName.toLowerCase()}>`
}

/**
 * Nearby text, used to disambiguate controls that share a name. A page with ten
 * buttons called "Select" is common; the heading above each one is what tells
 * them apart.
 */
function contextFor(el: Element): string | undefined {
  let node: Element | null = el.parentElement
  for (let hops = 0; node && hops < 4; hops++) {
    const own = clean(el.textContent ?? '')
    const text = clean(node.textContent ?? '', 240)
    const remainder = own ? clean(text.replace(own, '')) : text
    if (remainder.length >= 12) return remainder.length > 120 ? `${remainder.slice(0, 119)}…` : remainder
    node = node.parentElement
  }
  return undefined
}

/** What kind of control this is, in words the model can reason about. */
function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit

  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return (el as HTMLAnchorElement).href ? 'link' : 'generic'
  if (tag === 'button') return 'button'
  if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
  if (tag === 'textarea') return 'textbox'
  // A `<summary>` is the control you click to open a `<details>`; the details
  // itself is the thing that holds the revealed content.
  if (tag === 'summary') return 'button'
  if (tag === 'details') return 'disclosure'
  /*
   * A label takes its role from what it controls: the thing the user is actually
   * choosing. A label wrapping a radio *is* a radio button as far as the
   * interface is concerned — it is what gets clicked and what shows which choice
   * is selected — and reporting it as a "label" tells the agent nothing about
   * what it can do with it.
   */
  if (tag === 'label') {
    const control = labelControl(el as HTMLLabelElement)
    if (control) {
      if (control instanceof HTMLInputElement) {
        if (control.type === 'checkbox') return 'checkbox'
        if (control.type === 'radio') return 'radio'
      }
      return roleOf(control)
    }
    // A label with nothing to control is decoration.
    return 'generic'
  }
  // Landmarks, so the outline shows how the page is organised rather than
  // presenting a flat list of controls with no idea where they live.
  if (tag === 'form') return 'form'
  if (tag === 'fieldset') return 'group'
  if (tag === 'dialog') return 'dialog'
  if (tag === 'nav') return 'navigation'
  if (tag === 'main') return 'main'
  if (tag === 'table') return 'table'
  if (tag === 'ul' || tag === 'ol') return 'list'

  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      case 'submit':
      case 'button':
      case 'reset':
      case 'image': return 'button'
      case 'range': return 'slider'
      case 'number': return 'spinbutton'
      case 'search': return 'searchbox'
      case 'file': return 'file'
      case 'color': return 'color'
      case 'date':
      case 'datetime-local':
      case 'month':
      case 'week':
      case 'time': return 'date'
      default: return 'textbox'
    }
  }

  if (el.getAttribute('contenteditable') != null) return 'textbox'
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button'
  return 'generic'
}

/**
 * The control a `<label>` is for.
 *
 * Two ways a label attaches: the `for` attribute naming an id, or the control
 * being nested inside it. Both are common and both mean the same thing to a
 * person — clicking the label operates the control.
 */
function labelControl(label: HTMLLabelElement): HTMLElement | null {
  const id = label.htmlFor || label.getAttribute('for')
  if (id) {
    const found = label.ownerDocument.getElementById(id)
    if (found) return found
  }
  // The first labelable descendant; a label only ever controls one.
  return label.querySelector(
    'input, select, textarea, button, [role="button"], [role="radio"], [role="checkbox"]',
  )
}

/** The control a node drives, when it drives another element. */
function delegatingControl(el: Element): HTMLElement | null {
  if (!(el instanceof HTMLLabelElement)) return null
  return labelControl(el)
}

/** Current value, for the control types where a value is meaningful. */
function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return el.value ? '••••••••' : undefined
    if (el.type === 'checkbox' || el.type === 'radio') return undefined
    if (el.type === 'file') return el.files?.length ? `${el.files.length} file(s)` : undefined
    return el.value || undefined
  }
  if (el instanceof HTMLTextAreaElement) return el.value || undefined
  if (el instanceof HTMLSelectElement) {
    const selected = [...el.selectedOptions].map((o) => clean(o.textContent ?? ''))
    if (selected.length) return selected.join(', ')
    return el.value || undefined
  }
  if (el.getAttribute('contenteditable') != null) {
    const t = clean(el.textContent ?? '')
    return t || undefined
  }
  return undefined
}

/** Flags that change what the agent should do next. */
function stateOf(el: Element): string[] | undefined {
  /*
   * For a label driving a control, the state that matters is the control's.
   * Reporting a label's own attributes would say nothing about whether the choice
   * is currently selected — which is the single most useful thing to know about
   * it.
   */
  const control = delegatingControl(el)
  if (control) {
    const inherited = stateOf(control) ?? []
    // Selected-ness, in the vocabulary the model already reads.
    if (control instanceof HTMLInputElement && (control.type === 'radio' || control.type === 'checkbox')) {
      if (control.checked) return [...new Set([...inherited, 'checked'])]
      return inherited.length ? inherited : undefined
    }
    return inherited.length ? inherited : undefined
  }

  const out: string[] = []
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
  if (el instanceof HTMLInputElement) {
    if (el.required) out.push('required')
    if (el.readOnly) out.push('readonly')
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) out.push('checked')
    }
    if (el.maxLength > 0) out.push(`maxlength=${el.maxLength}`)
  }
  if (el.getAttribute('aria-expanded') === 'true') out.push('expanded')
  if (el.getAttribute('aria-expanded') === 'false') out.push('collapsed')
  if (el.getAttribute('aria-checked') === 'true') out.push('checked')
  if (el.getAttribute('aria-selected') === 'true') out.push('selected')
  if (el.getAttribute('aria-pressed') === 'true') out.push('pressed')
  if (el instanceof HTMLInputElement && el.type === 'password') out.push('password')
  const invalid = el.getAttribute('aria-invalid')
  if (invalid === 'true') out.push('invalid')
  if (invalid === 'false') out.push('valid')
  const required = el.getAttribute('aria-required') === 'true'
  if (required && !out.includes('required')) out.push('required')
  return out.length ? out : undefined
}

/** For a `<select>`, the options the model may choose from. */
function optionsOf(el: Element): string[] | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined
  return [...el.options].slice(0, 60).map((o) => clean(o.textContent ?? '', 60))
}

/**
 * Whether an element should appear in the tree.
 *
 * Containers are candidates in their own right, not merely context: a `<form>`
 * is what groups its fields, and dropping it produces a flat list of controls
 * with no indication of which belong together. A container that turns out to
 * hold nothing readable is pruned afterwards in `collectNodes`, so admitting
 * them here costs little.
 */
function isInteractiveCandidate(el: Element): boolean {
  if (isOurs(el)) return false

  /*
   * A label is reported only when its control is not.
   *
   * When the control is visible it is the better thing to report — it carries the
   * value, the options and the real state — and it already takes its name from the
   * label, so reporting both would present two elements with the same name and
   * role and no way for the agent to choose between them.
   *
   * The label earns its place in the opposite case: a quiz, survey or preference
   * screen where the input is visually hidden and the label is the whole of what
   * the user sees and clicks. Then the control is still reported (an off-screen
   * input is easy to miss) but the label is what the agent can actually identify
   * with — and clicking it operates the control.
   */
  if (el instanceof HTMLLabelElement) {
    const control = labelControl(el)
    if (control && isVisible(control)) return false
    // Nothing to control, or nothing the user can see: decoration either way.
    return Boolean(control)
  }

  if (el.matches(CANDIDATE_SELECTOR)) {
    const role = roleOf(el)
    if (role === 'presentation' || role === 'none') return false
    return true
  }

  /*
   * Last resort: an element that looks like something you can click, even though
   * nothing in the markup says so.
   *
   * Plenty of real interfaces are built from plain elements with the *appearance*
   * of a control and a click handler attached somewhere above them — a design
   * system's `<div class="option">`, a card that looks tappable, an answer tile
   * in a quiz. Keeping the candidate list to markup semantics is principled and
   * leaves the agent unable to see them, which is worse.
   *
   * Two strong signals, both of which mean "a person would try clicking this":
   * the pointer actually changes over it, or it declares itself visually
   * clickable. CSS alone cannot be inspected directly, so the computed cursor is
   * the honest test — it is exactly what the browser uses to tell the user the
   * same thing.
   *
   * Kept deliberately narrow: `cursor: pointer` on a *large* element is usually a
   * layout container with no handler of its own, and admitting those would fill
   * the tree with boxes. Size is the discriminator, since a real control is
   * small relative to the page.
   */
  if (el.closest('button, a, [role="button"], [role="link"]')) {
    // Already inside a real control; its wrapper is not another one.
    return false
  }

  const style = getComputedStyle(el)
  const clickable =
    style.cursor === 'pointer' ||
    el.hasAttribute('data-clickable') ||
    el.hasAttribute('data-action')

  if (!clickable) return false

  // A control, not a container: bounded in both directions. `vh` is deliberate
  // because a container with `cursor: pointer` is typically full-height or
  // full-width, while a control is a small tile.
  const position = style.position
  if (position === 'fixed' || position === 'absolute') {
    // Absolutely positioned big overlays are containers or scrims.
    const rect = el.getBoundingClientRect()
    if (rect.width > window.innerWidth * 0.8 || rect.height > window.innerHeight * 0.8) return false
  }

  // Text content, so the agent has something to name it by.
  const text = (el.textContent ?? '').trim()
  if (!text && !el.getAttribute('aria-label') && !el.getAttribute('title')) return false

  return true
}

/* -------------------------------------------------------------------------- */
/*  Tree walk                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Builds the tree of interactive elements.
 *
 * A recursive descent rather than a flat walk, for three reasons that all fall
 * out of the same thing — this is the only shape that mirrors how the page is
 * actually nested:
 *
 *  - **Shadow roots.** Descending through them here means a web component's
 *    guts are read as part of the page. A `TreeWalker` stops dead at a shadow
 *    boundary, which would hide every design-system button and, increasingly,
 *    whole login forms. Closed roots stay opaque; there is no way in.
 *
 *  - **Containers.** A `<form>` or `role="menu"` is not actionable but its
 *    children are, and keeping it as a parent is what makes the model's outline
 *    read like the page. Non-interactive wrappers (`div`, `span`, …) are hoisted
 *    so they never appear as tree levels — otherwise every element would sit
 *    three anonymous divs deep and the depth limit would truncate everything.
 *
 *  - **Depth.** `maxDepth` counts only the containers that survived, so it
 *    constrains the readable structure rather than the page's raw markup depth.
 *    Real pages nest 30+ elements deep purely from layout wrappers; counting
 *    those would trip the limit before reaching anything usable.
 */
function collectNodes(budget: ReadBudget): { nodes: PageNode[], truncated: boolean } {
  let counter = 0
  let truncated = false
  /** Guards against runaway recursion on pathological pages. */
  let visited = 0

  /**
   * Reads the interactive descendants of `node` into a flat list intended for
   * `parent`.
   */
  function scan(node: Node, parent: PageNode[], containerDepth: number): void {
    if (truncated) return

    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (truncated) return
      if (child.nodeType !== Node.ELEMENT_NODE) continue

      const el = child as Element
      if (++visited > budget.maxNodes * 40) {
        truncated = true
        return
      }

      // Never read our own UI as if it were page content.
      if (isOurs(el)) continue

      const notable = isInteractiveCandidate(el) && isVisible(el)

      if (notable) {
        if (counter >= budget.maxNodes) {
          truncated = true
          return
        }

        const node = describe(el, `n${counter++}`)
        registry.set(node.id, el)
        parent.push(node)

        if (CONTAINER_ROLES.has(node.role)) {
          if (containerDepth + 1 >= budget.maxDepth) {
            // Deep enough: keep the container, drop what is inside it.
            truncated = true
          } else {
            node.children = []
            scan(el, node.children, containerDepth + 1)
            // A container with nothing readable inside is noise; drop it so the
            // outline does not fill up with empty forms and menus.
            if (!node.children.length) {
              delete node.children
              parent.pop()
            }
          }
        }
        // Descend into shadow content of a notable element too — a button can
        // contain a tree of its own.
        if (!node.children && el.shadowRoot) scan(el.shadowRoot, parent, containerDepth)
        continue
      }

      // Not actionable: this is a layout wrapper. Look inside it without adding
      // a level, which is what keeps the tree about structure rather than markup.
      scan(el, parent, containerDepth)
      if (el.shadowRoot) scan(el.shadowRoot, parent, containerDepth)
    }
  }

  const roots: PageNode[] = []
  scan(document.body ?? document.documentElement, roots, 0)
  annotateAmbiguity(roots)
  return { nodes: roots, truncated }
}

/** Every node in a tree, flattened. */
function flattenNodes(nodes: PageNode[], out: PageNode[] = []): PageNode[] {
  for (const node of nodes) {
    out.push(node)
    if (node.children) flattenNodes(node.children, out)
  }
  return out
}

/**
 * Attaches surrounding text to the nodes that actually need it.
 *
 * Context is what tells ten buttons called "Select" apart, but gathering it for
 * every element is expensive and mostly noise: a node named "Free cancellation
 * only" gains nothing from also being told it sits near a form. So it is
 * computed afterwards, and only for names that are ambiguous in one of two ways
 * — the same name appears more than once on the page, or the name is short
 * enough ("Go", "Select", "More") that it does not identify anything on its own.
 */
function annotateAmbiguity(nodes: PageNode[]): void {
  const flat = flattenNodes(nodes)

  const counts = new Map<string, number>()
  for (const node of flat) {
    if (node.name) counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
  }

  for (const node of flat) {
    if (CONTAINER_ROLES.has(node.role)) continue
    const name = node.name.trim()
    const ambiguous =
      // Nothing to identify it by at all.
      !name ||
      // Several elements share this name, so the name alone does not pick one.
      (counts.get(node.name) ?? 0) > 1 ||
      // A generic word that could belong to anything on the page.
      GENERIC_LABELS.has(name.toLowerCase())
    if (!ambiguous) continue
    const el = registry.get(node.id)
    if (el) node.context = contextFor(el)
  }
}

/**
 * Names that identify nothing on their own.
 *
 * Deliberately a fixed list rather than a length test: "City" and "Guests" are
 * short but perfectly clear, whereas "Continue" is short and appears on half the
 * dialogs on the web. Length would flag both; this flags only the second.
 */
const GENERIC_LABELS = new Set([
  'select', 'choose', 'more', 'go', 'continue', 'submit', 'ok', 'okay', 'yes',
  'no', 'back', 'next', 'previous', 'close', 'open', 'menu', 'search', 'send',
  'save', 'edit', 'view', 'apply', 'cancel', 'done', 'skip', 'here', 'click',
  'learn more', 'read more', 'see more', 'details', 'options', 'settings',
])

/** Reads everything the agent might need to know about one element. */
function describe(el: Element, id: string): PageNode {
  const rect = el.getBoundingClientRect()
  const node: PageNode = {
    id,
    role: roleOf(el),
    name: accessibleName(el),
    value: valueOf(el),
    state: stateOf(el),
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
    inView: isInView(rect),
    // Page coordinates, not viewport-relative: a screenshot is captured against
    // the page as rendered, so this stays valid wherever the page is scrolled.
    rect: {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
    hint: hintFor(el),
  }

  /*
   * A container named after its subtree repeats the whole page text in the
   * element list — the same words the model has already been given, at a cost of
   * hundreds of tokens. A container is only worth naming when the page gave it a
   * name of its own.
   */
  if (CONTAINER_ROLES.has(node.role)) {
    const own =
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.getAttribute('title')
    if (!own) node.name = ''
  }

  // A dropdown's options are data, not addressable nodes, so they ride along in
  // the hint — the model needs to know what it may ask for, but each option is
  // not separately clickable.
  const opts = optionsOf(el)
  if (opts?.length) {
    node.hint = [node.hint, `options: ${opts.join(' | ')}`].filter(Boolean).join('; ')
  }
  return node
}

function hintFor(el: Element): string | undefined {
  const hints: string[] = []
  if (el instanceof HTMLInputElement) {
    if (el.type === 'email') hints.push('email address')
    if (el.type === 'tel') hints.push('phone number')
    if (el.type === 'date') hints.push('date')
    if (el.type === 'number') hints.push('number')
    if (el.type === 'search') hints.push('search box')
    if (el.autocomplete) hints.push(`autocomplete=${el.autocomplete}`)
  }
  if (el.getAttribute('name')) hints.push(`name=${el.getAttribute('name')}`)
  return hints.length ? hints.join('; ') : undefined
}

/**
 * Visible prose, whitespace-collapsed.
 *
 * Runs a separate pass from the interactive tree because the two want different
 * things: the model needs the page's *meaning* as continuous text, and it needs
 * the controls as an addressable list. Interleaving them produces a transcript
 * that is worse at both.
 */
function extractText(budget: ReadBudget): { text: string, truncated: boolean } {
  const parts: string[] = []
  let total = 0
  let truncated = false
  /**
   * Whether the previous emitted text ended inside the same run.
   *
   * Two adjacent text nodes are separate *nodes* but usually one *word* that
   * markup happened to split — `<b>can</b>cel` is the word "cancel", not "can
   * cel". Two text nodes with an element boundary that rendered as a block
   * between them are genuinely separate. Rather than guess at the boundary, the
   * separator is deferred to the next text node: an intervening block element
   * resets the flag, a bare inline element does not.
   */
  let pendingSeparator = false

  const emit = (raw: string): void => {
    if (total >= budget.maxText) {
      truncated = true
      return
    }
    const piece = raw.replace(/\s+/g, ' ')
    const text = pendingSeparator ? ` ${piece}` : piece
    pendingSeparator = false

    if (total + text.length > budget.maxText) {
      parts.push(text.slice(0, Math.max(0, budget.maxText - total)))
      total = budget.maxText
      truncated = true
      return
    }
    parts.push(text)
    total += text.length
  }

  const visit = (node: Node, depth: number): void => {
    if (truncated || depth > budget.maxDepth + 8) return
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (truncated) return

      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.nodeValue ?? ''
        // Skip text inside a control we already describe; the model would
        // otherwise read every button twice, once as text and once as a node.
        const parent = child.parentElement
        if (parent && isOurs(parent)) continue

        /*
         * A whitespace-only text node is the boundary between two inline
         * elements — the newline in `<a>Home</a>\n<a>Search</a>`. It has to be
         * observed *before* the empty-content check below discards it, because
         * discarding it is what makes adjacent links read as "HomeSearch".
         */
        if (!raw.trim()) {
          if (raw.length) pendingSeparator = true
          continue
        }
        if (/^\s/.test(raw)) pendingSeparator = true
        emit(raw.trim())
        /*
         * Trailing whitespace is a boundary for whatever comes *next*. Without
         * this, "You may <b>can</b>cel" loses the space that was already in the
         * source and reads as "You maycancel".
         */
        pendingSeparator = /\s$/.test(raw)
        continue
      }

      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      if (SKIP_TEXT_TAGS.has(el.tagName)) continue
      if (isOurs(el)) continue
      if (el.getAttribute('aria-hidden') === 'true') continue

      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      // A block-level box is a real boundary in the reading order, so it both
      // starts a new line and breaks any run of text that was in progress.
      const display = style.display
      const isBlock =
        display === 'block' || display === 'flex' || display === 'grid' ||
        display === 'list-item' || display === 'table' || display === 'table-row'
      if (isBlock) {
        parts.push('\n')
        pendingSeparator = false
      }

      visit(el, depth + 1)
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1)

      if (el.tagName === 'BR') {
        parts.push('\n')
        pendingSeparator = false
      }
    }
  }

  visit(document.body ?? document.documentElement, 0)

  const text = parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text, truncated }
}

/* -------------------------------------------------------------------------- */
/*  Reading a frame                                                            */
/* -------------------------------------------------------------------------- */

function viewportInfo(): ViewportInfo {
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    scrollHeight: Math.max(document.documentElement.scrollHeight, window.innerHeight),
    dpr: window.devicePixelRatio || 1,
  }
}

/** Whether a frame is worth reporting at all. */
function frameIsTrivial(): boolean {
  const body = document.body
  if (!body) return true
  const rect = body.getBoundingClientRect()
  const hasControls = document.querySelector(CANDIDATE_SELECTOR) !== null
  return rect.width < 2 || rect.height < 2 ? !hasControls : false
}

function readFrame(budget: ReadBudget): FrameRead {
  resetRegistry()
  registryUrl = location.href

  const hidden = frameIsTrivial()
  if (hidden) {
    return {
      frameId: -1,
      url: location.href,
      title: document.title || '',
      hidden: true,
      viewport: viewportInfo(),
      text: '',
      nodes: [],
      truncated: false,
    }
  }

  const { nodes, truncated: nodesTruncated } = collectNodes(budget)
  const { text, truncated: textTruncated } = extractText(budget)

  return {
    frameId: -1,
    url: location.href,
    title: document.title || '',
    hidden: false,
    viewport: viewportInfo(),
    text,
    nodes,
    truncated: nodesTruncated || textTruncated,
  }
}

/* -------------------------------------------------------------------------- */
/*  Acting on a frame                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sets a value the way the framework expects.
 *
 * React (and every other controlled-input library) tracks the previous value on
 * the DOM node and ignores an `input` event whose value it believes it already
 * has. Writing through the *native* prototype setter and then dispatching a
 * bubbling `input` is what makes a controlled input actually update — assigning
 * `el.value` directly looks like it worked and is silently discarded on the next
 * render.
 */
function setNativeValue(el: HTMLElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else (el as any).value = value
}

function focusElement(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true })
  } catch {
    el.focus()
  }
}

/**
 * A full pointer and mouse sequence, then `click()` if nothing handled it.
 *
 * `el.click()` alone dispatches only a `click` event, so handlers bound to
 * `mousedown` — which includes most drag, menu and canvas-driven UIs — never
 * fire. Doing the sequence first and falling back covers both.
 */
function clickElement(el: Element): void {
  const target = el as HTMLElement
  scrollIntoViewIfNeeded(el)

  /*
   * A label driving a control gets both clicks.
   *
   * The browser's own label behaviour synthesises a click on the control, and the
   * page may rely on it — but only when the label is genuinely associated, which
   * is exactly what is uncertain here. Dispatching on both means the control ends
   * up operated either way. It is idempotent in the ways that matter: a radio or
   * checkbox converges on the same state, and a button's handler firing twice is
   * prevented by the page's own re-entrancy in practice, where a fire-once guard
   * is the normal pattern.
   */
  const delegated = delegatingControl(el)
  if (delegated && delegated !== (el as unknown as HTMLElement)) {
    dispatchClickSequence(delegated)
  }

  dispatchClickSequence(target)
}

/**
 * Sends the full pointer sequence to one element.
 *
 * `el.click()` alone dispatches only a `click` event, so handlers bound to
 * `mousedown` — which includes most drag, menu and canvas-driven UIs — never
 * fire. Doing the sequence first and falling back covers both.
 */
function dispatchClickSequence(el: Element): void {
  const target = el as HTMLElement
  const rect = el.getBoundingClientRect()
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    buttons: 1,
    view: window,
  }

  let handled = false
  const markHandled = () => {
    handled = true
  }
  // Listen once for a real handler, so a click is only synthesised when needed.
  el.addEventListener('click', markHandled, { once: true, capture: true })

  target.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
  target.dispatchEvent(new MouseEvent('mousedown', base))
  focusElement(target)
  target.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, isPrimary: true }))
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))

  if (!handled) target.click()

  el.removeEventListener('click', markHandled, { capture: true } as EventListenerOptions)
}

function scrollIntoViewIfNeeded(el: Element): void {
  const rect = el.getBoundingClientRect()
  const fullyVisible =
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth
  if (fullyVisible) return
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  } catch {
    el.scrollIntoView({ block: 'center' })
  }
}

/**
 * Puts the caret at the end of an editable element's content.
 *
 * Where the text lands matters: inserting at the end appends, which is what an
 * agent adding a search term to an existing query expects.
 */
function caretToEnd(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const end = el.value.length
    try {
      el.setSelectionRange(end, end)
    } catch {
      // Throws for input types that do not support selection (email, number,
      // date). Harmless: the element is already focused, so an insert still
      // lands at the end.
    }
    return
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Selects everything in an editable element, so an insert replaces it. */
function selectContents(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * Types into an element the way a person would, through the browser's own
 * editing machinery.
 *
 * Assigning `value` and dispatching a synthetic `input` is enough for a plain
 * form and for React's controlled inputs — but it is not enough for everything.
 * Rich text editors, input masks, and any framework that commits on
 * `beforeinput` or keeps its own model of the document only update when the
 * browser actually performs an edit. Against those, the assigned value sits in
 * the DOM while the site's own state stays empty, and the form submits nothing.
 * A single real keystroke from the user fixes it because it goes through the
 * pipeline the site is listening to — which is the tell.
 *
 * `execCommand('insertText')` drives that same pipeline: it fires `beforeinput`,
 * updates the selection, raises an `input` event of type `inputType`, and lets
 * the framework's own handler run. It is formally deprecated and has no
 * replacement for this purpose; every browser still implements it, and it is
 * what the widely used automation libraries rely on.
 *
 * The direct-write path is kept as a fallback, because `insertText` does nothing
 * for input types the editing system refuses (`number`, `date`, `range`, and
 * `file`) — and for those, setting the value is the only thing that works.
 */
/**
 * Commits an edit the way leaving the field does.
 *
 * Plenty of forms do nothing until the field is left: the value is read on
 * `blur`, not on `input`. A synthetic `change` is not a substitute — plenty of
 * code listens for `blur` itself — and without this the field visibly holds the
 * text while the site still considers it empty, which is exactly the symptom of
 * typing that appears to work and then submits nothing.
 *
 * `focusout` first, then `blur`: that is the order a browser uses. `focusout`
 * bubbles, `blur` does not, and code depends on both.
 */
function commitEdit(el: HTMLElement): void {
  /*
   * Deliberately not gated on `document.activeElement === el`.
   *
   * Refusing to commit when the element is not the active one sounds safer and
   * is the opposite: focus does not always take in a background tab, which is
   * the normal state while an agent works, and bailing there would reproduce the
   * exact bug this exists to fix — the field filled, the site unaware. This
   * element *was* focused by `typeInto` a moment ago, so leaving it is honest;
   * and a spurious blur costs far less than a missing one.
   */
  const init = { bubbles: true, composed: true, cancelable: false }
  el.dispatchEvent(new FocusEvent('focusout', { ...init, relatedTarget: null }))
  el.dispatchEvent(new FocusEvent('blur', { ...init, bubbles: false }))
  // Reflect that focus really has moved, so code reading `activeElement` agrees.
  if (document.activeElement === el) {
    try {
      el.blur()
    } catch {
      /* some elements refuse; the events above are what matter */
    }
  }
}

/**
 * Inserts one character the way the browser's editing system would.
 *
 * Returns whether the editing system engaged. It will not when the document is
 * not focused — the usual state while an agent is working, because the user is
 * watching the panel rather than the field — and that is the single most common
 * reason a synthetic edit goes unnoticed. The caller falls back to writing the
 * value directly, which at least keeps the DOM honest and still fires `input`.
 *
 * `beforeinput` is dispatched by hand on the fallback path so that a listener
 * which cancels the edit is still respected: an input mask refusing a character
 * must not be overridden.
 */
type InsertOutcome = 'inserted' | 'cancelled' | 'refused'

function insertCharacter(el: HTMLElement, char: string): InsertOutcome {
  const editable = el.getAttribute('contenteditable') != null

  if (editable) {
    const before = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'insertText',
      data: char,
    })
    if (!el.dispatchEvent(before)) return 'cancelled' // the page refused it
    el.textContent = (el.textContent ?? '') + char
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }),
    )
    return 'inserted'
  }

  /*
   * The real path. Only usable while the document is focused; it returns false
   * otherwise, and `beforeinput` will not have fired.
   */
  try {
    if (document.execCommand('insertText', false, char)) return 'inserted'
  } catch {
    /* fall through to the direct write */
  }

  const before = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertText',
    data: char,
  })
  if (!el.dispatchEvent(before)) return 'cancelled'

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  const current = descriptor?.get?.call(el) ?? (el as HTMLInputElement).value ?? ''
  const start = (el as HTMLInputElement).selectionStart ?? current.length
  const end = (el as HTMLInputElement).selectionEnd ?? current.length
  const next = current.slice(0, start) + char + current.slice(end)
  setNativeValue(el, next)
  try {
    ;(el as HTMLInputElement).setSelectionRange(start + char.length, start + char.length)
  } catch {
    /* input types without selection support */
  }
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }),
  )
  return 'inserted'
}

/** The key and code a character would carry if a person had pressed it. */
function keyInfo(char: string): { key: string; code: string } {
  if (char === ' ') return { key: ' ', code: 'Space' }
  if (/^[a-zA-Z]$/.test(char)) return { key: char, code: `Key${char.toUpperCase()}` }
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}` }
  const shifted: Record<string, string> = {
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
    _: 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
    '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma',
    '>': 'Period', '?': 'Slash', '~': 'Backquote',
  }
  return { key: char, code: shifted[char] ?? '' }
}

/**
 * Types into an element the way a person would.
 *
 * Character by character, with the whole keyboard sequence per character, and a
 * commit at the end. That is more work than assigning the value, and it is the
 * only version that survives contact with real sites:
 *
 *  - **Per-character key events.** Frameworks that track keystrokes — search
 *    boxes with debounced queries, autocomplete, anything counting characters —
 *    see nothing from a single bulk assignment. They see a person typing.
 *
 *  - **The browser's editing pipeline.** `execCommand('insertText')` performs a
 *    genuine edit: it fires `beforeinput`, updates the selection, raises `input`
 *    with an `inputType`, and lets the framework's own handler run. Assigning
 *    `value` and firing `input` satisfies React's tracker but not an editor that
 *    commits on `beforeinput`.
 *
 *  - **A commit at the end.** See `commitEdit`: the value is often only read
 *    when the field is left.
 *
 * The direct write remains as a fallback for input types the editing system
 * refuses — `number`, `date`, `range`, `file` — and for the case where the
 * document is not focused and `execCommand` cannot engage at all.
 */
async function typeInto(el: Element, text: string, clear: boolean, submit: boolean): Promise<void> {
  const target = el as HTMLElement
  scrollIntoViewIfNeeded(el)
  focusElement(target)

  const editable = el.getAttribute('contenteditable') != null
  const read = (): string =>
    editable ? (el.textContent ?? '') : ((el as HTMLInputElement).value ?? '')

  const before = read()

  if (clear) selectContents(target)
  else caretToEnd(target)

  /*
   * A whole-string insert is tried first when it will definitely work, because it
   * is one edit rather than N and is less likely to trip a per-keystroke
   * reformatter mid-way. It is skipped when the field is empty and the text is
   * long, where per-character is what makes a site with autocomplete behave.
   */
  let refused = false

  for (const char of text) {
    const { key, code } = keyInfo(char)
    const keyInit: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, composed: true }

    // A handler that cancels the keydown is refusing the character outright.
    if (!target.dispatchEvent(new KeyboardEvent('keydown', keyInit))) {
      refused = true
      continue
    }

    if (insertCharacter(target, char) === 'cancelled') refused = true

    target.dispatchEvent(new KeyboardEvent('keyup', keyInit))
  }

  /*
   * If nothing landed at all — an unfocused document, or a field that refuses
   * the editing system entirely — fall back to writing the whole value. Judged by
   * what the element holds rather than by any return value, because a framework
   * may legitimately reformat what it received and that still counts as success.
   *
   * Crucially, *not* when the page cancelled the edit. An input mask that
   * refuses a character has made a decision, and forcing the text in anyway
   * leaves the field holding something the site considers invalid — worse than
   * failing, because the user has no way to tell the site never agreed to it.
   */
  if (!refused && read() === before && text) {
    const wanted = clear ? text : before + text
    if (editable) el.textContent = wanted
    else setNativeValue(target, wanted)
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }),
    )
  }

  target.dispatchEvent(new Event('change', { bubbles: true }))

  /*
   * `change` does not reach code that listens for `blur`, so the edit is
   * committed by leaving the field as well. Done after `change` because that is
   * the order a browser uses when a field is left.
   */
  commitEdit(target)

  if (submit) {
    await sleep(60)
    await pressKey(el, 'Enter')
  }
}

async function pressKey(el: Element | null, key: string): Promise<void> {
  const target = (el as HTMLElement) ?? (document.activeElement as HTMLElement) ?? document.body
  const init: KeyboardEventInit = {
    key,
    code: keyToCode(key),
    bubbles: true,
    cancelable: true,
    composed: true,
  }

  const down = new KeyboardEvent('keydown', init)
  const notCancelled = target.dispatchEvent(down)
  target.dispatchEvent(new KeyboardEvent('keypress', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))

  if (!notCancelled) return // a handler called preventDefault; respect it

  // Enter inside a form submits it, unless the page handled the key itself.
  if (key === 'Enter') {
    const form = (target as HTMLElement).closest?.('form') as HTMLFormElement | null
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit()
      } catch {
        // requestSubmit throws on an invalid form; the browser's own validation
        // UI has already told the user why, so leave it be.
      }
    }
  }
}

function keyToCode(key: string): string {
  if (key === 'Enter') return 'Enter'
  if (key === 'Tab') return 'Tab'
  if (key === 'Escape') return 'Escape'
  if (key === ' ') return 'Space'
  if (key.startsWith('Arrow')) return key
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return key
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Native setter for a `<select>`, matching the framework-safe path above. */
function selectOption(el: Element, value: string): { ok: boolean, message: string } {
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, message: 'That element is not a dropdown.' }
  }

  const byValue = [...el.options].find((o) => o.value === value)
  const byText = [...el.options].find((o) => clean(o.textContent ?? '').toLowerCase() === value.toLowerCase())
  const byPartial = [...el.options].find((o) =>
    clean(o.textContent ?? '').toLowerCase().includes(value.toLowerCase()),
  )
  const match = byValue ?? byText ?? byPartial

  if (!match) {
    const available = [...el.options].map((o) => clean(o.textContent ?? '')).filter(Boolean)
    return {
      ok: false,
      message: `No option matching "${value}". Available: ${available.join(' | ') || '(none)'}`,
    }
  }

  match.selected = true
  setNativeValue(el, match.value)
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  return { ok: true, message: `Selected "${clean(match.textContent ?? '')}"` }
}

async function performOp(op: AgentOp, budget: ReadBudget): Promise<OpResult> {
  switch (op.op) {
    case 'read': {
      const frame = readFrame(budget)
      return {
        ok: true,
        message: 'Read the page.',
        // A single frame answering for itself cannot know what its siblings are,
        // so it reports none as unreadable; the bridge fills that in when it
        // assembles the whole page.
        snapshot: {
          url: frame.url,
          title: frame.title,
          viewport: frame.viewport,
          frames: [frame],
          unreadable: [],
          marks: [],
          truncated: frame.truncated,
        },
      }
    }

    case 'wait': {
      await sleep(Math.min(Math.max(op.ms, 0), 10_000))
      return { ok: true, message: `Waited ${op.ms} ms.` }
    }

    case 'scroll': {
      const amount = op.amount ?? Math.round(window.innerHeight * 0.8)
      if (op.direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      else if (op.direction === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior })
      } else {
        const dy = op.direction === 'down' ? amount : -amount
        window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior })
      }
      await sleep(120)
      return { ok: true, message: `Scrolled ${op.direction}.` }
    }

    case 'key': {
      await pressKey(null, op.key)
      return { ok: true, message: `Pressed ${op.key}.` }
    }
  }

  // Everything below needs a live element.
  const ref = (op as { ref?: string }).ref
  if (!ref) return { ok: false, message: 'No element reference given.' }

  const { el, error } = resolveRef(ref)
  if (!el) return { ok: false, message: error ?? 'Element not found.', error: error ?? undefined }

  const label = accessibleName(el)

  switch (op.op) {
    case 'click': {
      clickElement(el)
      await sleep(90)
      return { ok: true, message: `Clicked "${label}".` }
    }

    case 'hover': {
      scrollIntoViewIfNeeded(el)
      const r = el.getBoundingClientRect()
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        view: window,
      }
      el.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new MouseEvent('mouseover', init))
      el.dispatchEvent(new MouseEvent('mousemove', init))
      await sleep(70)
      return { ok: true, message: `Hovered "${label}".` }
    }

    case 'type': {
      await typeInto(el, op.text, op.clear ?? true, op.submit ?? false)
      await sleep(90)
      return {
        ok: true,
        message: op.submit
          ? `Typed into "${label}" and pressed Enter.`
          : `Typed into "${label}".`,
      }
    }

    case 'select': {
      const res = selectOption(el, op.value)
      await sleep(90)
      return { ok: res.ok, message: `${res.message}${res.ok ? ' ' : ''}`, error: res.ok ? undefined : res.message }
    }

    case 'check': {
      const isCheckable =
        (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) ||
        el.getAttribute('role') === 'checkbox' ||
        el.getAttribute('role') === 'radio' ||
        el.getAttribute('role') === 'switch'
      if (!isCheckable) {
        return { ok: false, message: `"${label}" is not a checkbox or radio button.`, error: 'not checkable' }
      }
      const currently =
        el instanceof HTMLInputElement
          ? el.checked
          : el.getAttribute('aria-checked') === 'true'
      if (currently !== op.checked) {
        clickElement(el)
        await sleep(80)
      }
      return {
        ok: true,
        message: `${op.checked ? 'Checked' : 'Unchecked'} "${label}".`,
      }
    }

    case 'focus': {
      scrollIntoViewIfNeeded(el)
      focusElement(el as HTMLElement)
      return { ok: true, message: `Focused "${label}".` }
    }

    default:
      return { ok: false, message: `Unknown operation "${(op as { op: string }).op}".` }
  }
}

/* -------------------------------------------------------------------------- */
/*  Screenshot annotation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Draws the agent's numbered boxes onto a screenshot.
 *
 * This runs in the page rather than the background because a background script
 * has no DOM, and an offscreen document would add a whole extra context for one
 * canvas. The screenshot arrives as a data URL, gets a canvas drawn over it, and
 * goes straight back.
 */
async function annotate(
  dataUrl: string,
  marks: { x: number, y: number, w: number, h: number, ref: string }[],
  viewportWidth: number,
): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode the screenshot.'))
    img.src = dataUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl

  ctx.drawImage(image, 0, 0)

  // The screenshot is in device pixels; the rects are in CSS pixels.
  const scale = canvas.width / Math.max(viewportWidth, 1)
  const fontPx = Math.round(13 * scale)

  ctx.lineWidth = Math.max(2, 2 * scale)
  ctx.strokeStyle = 'rgba(47, 111, 237, 0.95)'
  ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textBaseline = 'bottom'

  for (const mark of marks) {
    const x = mark.x * scale
    const y = mark.y * scale
    const w = mark.w * scale
    const h = mark.h * scale

    ctx.fillStyle = 'rgba(47, 111, 237, 0.12)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)

    const padX = 4 * scale
    const padY = 3 * scale
    const boxH = fontPx + padY * 2
    const boxW = ctx.measureText(mark.ref).width + padX * 2
    // Keep the label on-canvas when the element is at the very top.
    const labelY = y - boxH < 0 ? y : y - boxH

    ctx.fillStyle = 'rgb(47, 111, 237)'
    ctx.fillRect(x, labelY, boxW, boxH)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(mark.ref, x + padX, labelY + boxH - padY)
  }

  return canvas.toDataURL('image/png')
}

/* -------------------------------------------------------------------------- */
/*  Message handling                                                           */
/* -------------------------------------------------------------------------- */

const isTopFrame = (() => {
  try {
    return window.self === window.top
  } catch {
    return false // cross-origin access denied means we are not the top frame
  }
})()

function handleMessage(msg: any, _sender: unknown, sendResponse: (r: any) => void): boolean {
  if (msg?.type === 'frame/read') {
    try {
      sendResponse({ ok: true, frame: readFrame({ ...DEFAULT_BUDGET, ...(msg.budget ?? {}) }) })
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return false
  }

  if (msg?.type === 'frame/exec') {
    const budget = { ...DEFAULT_BUDGET, ...(msg.budget ?? {}) }
    performOp(msg.op as AgentOp, budget)
      .then((result) => {
        const frame = readFrame(budget)
        frame.frameId = msg.frameId ?? -1
        sendResponse({
          ok: true,
          result,
          // Refs are re-issued by that read, so hand back the current outlines
          // for anything drawing them.
          nodes: frame.nodes,
        })
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    return true // async response
  }


  if (msg?.type === 'frame/annotate') {
    annotate(msg.dataUrl, msg.marks ?? [], msg.viewportWidth ?? window.innerWidth)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true // async response
  }

  // The overlay asks for frame identity when it mounts.

  return false
}

// Firefox's promise-based API returns a promise when the listener is declared
// without a callback; a sync-returning listener that also calls sendResponse is
// the portable form across both Firefox and Chromium.
const api = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome
api.runtime.onMessage.addListener(handleMessage as any)

// Announce readiness so the background knows this frame can be driven. Frames
// created later (an iframe injected after load) never send this, so the
// background also probes on demand rather than trusting the announcement.
api.runtime
  .sendMessage({ type: 'frame/ready', top: isTopFrame, url: location.href })
  .catch(() => {
    // The background may not be listening yet; it will probe instead.
  })

export {}