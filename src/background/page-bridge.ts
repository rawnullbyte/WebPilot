/**
 * The bridge between the agent loop and the page.
 *
 * Its job is to turn "one tab" into "one readable, addressable page". The agent
 * never talks to a content script directly and never sees a frame id it has to
 * manage: it sees refs of the form `f3:n12`, and this module is what splits them
 * back into a target frame and an element within it.
 *
 * That indirection is the whole reason iframes work. A form embedded in an
 * iframe is a content script running in a different document, with its own
 * elements and its own ref namespace; flattening everything under a single
 * `f<frameId>` prefix is what lets the model treat a nested checkout widget and
 * a top-level button as the same kind of thing.
 */

import { ext } from '@/shared/settings'
import type { AgentOp, FrameRead, PageNode, Rect, Snapshot, ViewportInfo } from '@/shared/types'

/** Overall ceilings for one page read, applied across all frames. */
export const READ_BUDGET = {
  maxText: 12_000,
  maxNodes: 400,
  maxDepth: 15,
  /** Total characters of page text handed to the model in one turn. */
  totalText: 28_000,
  /** Total interactive nodes across the page. */
  totalNodes: 700,
  /** Frames beyond this are reported as present but unread. */
  maxFrames: 12,
}

/* -------------------------------------------------------------------------- */
/*  Frame enumeration                                                          */
/* -------------------------------------------------------------------------- */

type FrameInfo = {
  frameId: number
  parentFrameId: number
  url: string
}

async function listFrames(tabId: number): Promise<FrameInfo[]> {
  try {
    const frames = await ext.webNavigation.getAllFrames({ tabId })
    return (frames ?? []).map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url ?? '',
    }))
  } catch {
    // `getAllFrames` can fail on a tab that is mid-navigation, or on a tab the
    // browser considers privileged. Fall back to just the top frame.
    return [{ frameId: 0, parentFrameId: -1, url: '' }]
  }
}

const SKIP_FRAME_URL = /^(about:blank|about:srcdoc)$/i

/** Frames that will never hold anything the user cares about. */
function isAdOrTracker(url: string): boolean {
  return /(doubleclick|googlesyndication|googletagmanager|google-analytics|facebook\.com\/tr|scorecardresearch|adservice|adsystem|taboola|outbrain|criteo|pubmatic|rubiconproject)/i
    .test(url)
}

/* -------------------------------------------------------------------------- */
/*  Talking to one frame                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of a message to one frame.
 *
 * These two cases must stay distinct. "The frame did not answer" means there is
 * no content script there — usually because the page navigated — and the right
 * response is to re-read. "The frame answered with an error" means the script is
 * alive and telling us something specific, such as that a reference is stale or
 * an element was never a checkbox. Collapsing them would have the agent tell the
 * model "the page navigated" every time a click failed, sending it off to
 * re-read a page that never changed.
 */
type FrameReply<T> = { ok: true, value: T } | { ok: false, error: string }

/**
 * The one error string that means "no content script answered".
 *
 * A shared constant rather than a repeated literal, because `execOp` compares
 * against it to tell a vanished frame from a page that answered with a refusal —
 * and a drift between the two would silently start blaming navigation for every
 * failed action.
 */
const NO_ANSWER = 'The frame did not answer.'

async function askFrame<T>(tabId: number, frameId: number, message: unknown): Promise<FrameReply<T>> {
  try {
    const res = (await ext.tabs.sendMessage(tabId, message, { frameId })) as
      | ({ ok: true } & T)
      | { ok: false, error: string }
      | undefined

    if (!res) {
      return { ok: false, error: NO_ANSWER }
    }
    if (res.ok === false) {
      return { ok: false, error: res.error || 'The frame reported a failure.' }
    }
    return { ok: true, value: res as T }
  } catch {
    // No content script in that frame — it may have loaded before the extension
    // did, or the site blocked injection into it.
    return { ok: false, error: NO_ANSWER }
  }
}

/** Whether a reply actually carries a usable frame reading. */
function isFrameRead(value: unknown): value is FrameRead {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<FrameRead>
  return (
    typeof frame.url === 'string' &&
    Array.isArray(frame.nodes) &&
    typeof frame.text === 'string' &&
    typeof frame.truncated === 'boolean'
  )
}

async function ensureContentScript(tabId: number, frameId: number): Promise<boolean> {
  try {
    await ext.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['src/content/page.js'],
    })
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading the page                                                           */
/* -------------------------------------------------------------------------- */

export async function readPage(tabId: number): Promise<Snapshot> {
  const tab = await ext.tabs.get(tabId).catch(() => null)

  // The tab may have no content script at all — a fresh tab, an extension page,
  // a PDF viewer. Inject on demand rather than reporting an empty page.
  let frames = await listFrames(tabId)
  if (!frames.length) frames = [{ frameId: 0, parentFrameId: -1, url: '' }]

  const results = await Promise.all(
    frames.slice(0, READ_BUDGET.maxFrames).map(async (info) => {
      /*
       * `read.value.frame` is validated, not assumed.
       *
       * A reply without a frame means the content script is an older build — the
       * usual cause is reloading the extension, which leaves the scripts already
       * injected into open tabs running the previous version until those tabs
       * navigate. Reading `.frame` off it yields `undefined`, which then flows
       * into the frame list and throws on the first property access, losing the
       * *entire* page read rather than just that frame. Treating a malformed
       * reply as "could not read this frame" keeps everything else working, and
       * the frame is reported to the model as unreadable rather than vanishing.
       */
      const read = await askFrame<{ frame: FrameRead }>(tabId, info.frameId, {
        type: 'frame/read',
        budget: READ_BUDGET,
      })
      if (read.ok && isFrameRead(read.value.frame)) return { info, frame: read.value.frame }

      const injected = await ensureContentScript(tabId, info.frameId)
      if (!injected) return { info, frame: null }

      const retry = await askFrame<{ frame: FrameRead }>(tabId, info.frameId, {
        type: 'frame/read',
        budget: READ_BUDGET,
      })
      return { info, frame: retry.ok && isFrameRead(retry.value.frame) ? retry.value.frame : null }
    }),
  )

  /*
   * Drop frames that amount to nothing: hidden tracking pixels, ad slots that
   * never rendered, and the `about:blank` placeholder every page carries.
   *
   * Note what is *not* filtered on: `frame.frameId`. A content script has no way
   * to know its own frame id, so the value it reports is a placeholder — the
   * authoritative id is `info.frameId`, from `webNavigation.getAllFrames`, and it
   * is stamped on further down. Filtering on the placeholder discards every
   * frame, which presents as an agent that connects to the model and then sees
   * a blank page.
   */
  const usable = results.filter(
    (r): r is { info: FrameInfo, frame: FrameRead } =>
      r.frame !== null &&
      !r.frame.hidden &&
      !(SKIP_FRAME_URL.test(r.frame.url) && r.frame.text.length === 0 && r.frame.nodes.length === 0) &&
      !(isAdOrTracker(r.frame.url) && r.frame.nodes.length === 0),
  )

  // Top frame first — it carries the page's identity and its main controls, so
  // it should be the part that survives truncation.
  usable.sort((a, b) => {
    if (a.info.frameId === 0) return -1
    if (b.info.frameId === 0) return 1
    return a.info.parentFrameId - b.info.parentFrameId
  })

  /*
   * Frames that exist but produced nothing readable.
   *
   * Filtered to exclude the ones that are *meant* to be empty — analytics and ad
   * slots — because listing those would train the model to ignore this section.
   * What remains is a real part of the page the agent cannot see into.
   */
  const unreadable = results
    .filter((r) => r.frame === null || r.frame.hidden)
    .map((r) => ({ frameId: r.info.frameId, url: r.info.url }))
    .filter((f) => f.frameId !== 0 && f.url && !isAdOrTracker(f.url))

  let textBudget = READ_BUDGET.totalText
  let nodeBudget = READ_BUDGET.totalNodes
  let truncated = false
  const keptFrames: FrameRead[] = []
  const marks: (Rect & { ref: string })[] = []

  for (const { info, frame } of usable) {
    const text = frame.text.length > textBudget ? frame.text.slice(0, textBudget) : frame.text
    if (text.length < frame.text.length) truncated = true
    textBudget -= text.length

    /*
     * A frame that hit its *own* budget read only part of itself. That has to
     * propagate: the frame reported `truncated: true`, and dropping it here would
     * present a page cut short mid-sentence as if it were complete, leaving the
     * model to conclude that what it can see is all there is.
     */
    if (frame.truncated) truncated = true

    const nodes = frame.nodes
    const nodeCount = countNodes(nodes)
    if (nodeCount > nodeBudget) {
      truncated = true
      continue // keep the text but drop the controls; the model can read_page
    }
    nodeBudget -= nodeCount

    const withPrefix = prefixNodes(nodes, info.frameId)
    keptFrames.push({ ...frame, frameId: info.frameId, text, nodes: withPrefix })

    // Marks for the screenshot, top frame only: a child frame's rects are in
    // its own coordinate space, and offsetting them correctly needs the iframe
    // element's box, which is not knowable when it is cross-origin.
    if (info.frameId === 0) {
      collectMarks(withPrefix).forEach((m) => marks.push(m))
    }

    if (textBudget <= 0) {
      truncated = true
      break
    }
  }

  const top = keptFrames.find((f) => f.frameId === 0)

  return {
    url: tab?.url ?? top?.url ?? '',
    title: tab?.title ?? top?.title ?? '',
    viewport: top?.viewport ?? fallbackViewport(),
    frames: keptFrames,
    unreadable,
    marks,
    truncated,
  }
}

function fallbackViewport(): ViewportInfo {
  return {
    scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 800,
    scrollWidth: 1280, scrollHeight: 800, dpr: 1,
  }
}

function countNodes(nodes: PageNode[]): number {
  let n = 0
  for (const node of nodes) {
    n += 1
    if (node.children) n += countNodes(node.children)
  }
  return n
}

/** Rewrites `n12` into `f0:n12` so a ref is meaningful page-wide. */
function prefixNodes(nodes: PageNode[], frameId: number): PageNode[] {
  return nodes.map((node) => ({
    ...node,
    id: `f${frameId}:${node.id}`,
    children: node.children ? prefixNodes(node.children, frameId) : undefined,
  }))
}

/**
 * Collects the boxes to draw onto a screenshot, for the top frame only.
 *
 * A child frame's rects are in that frame's own coordinate space. Offsetting
 * them into page coordinates needs the iframe element's box, which is not
 * knowable when the frame is cross-origin — so embedded frames are drawn
 * unlabelled rather than drawn in the wrong place, which would be worse than
 * not drawing them at all.
 */
function collectMarks(nodes: PageNode[]): (Rect & { ref: string })[] {
  const out: (Rect & { ref: string })[] = []
  for (const node of nodes) {
    if (node.rect && node.rect.w > 0 && node.rect.h > 0) {
      out.push({ ...node.rect, ref: node.id })
    }
    if (node.children) out.push(...collectMarks(node.children))
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Executing an operation                                                     */
/* -------------------------------------------------------------------------- */

export type ExecOutcome = {
  ok: boolean
  message: string
  error?: string
  /** The page changed enough that the model should re-read before acting. */
  stale: boolean
  /**
   * The frame's re-issued element references, already page-prefixed.
   *
   * Every exec re-reads its frame, which re-issues that frame's refs. Handing
   * them back lets the caller keep its snapshot in step for free — otherwise a
   * second action in the same turn could address a different element under an id
   * that still looks valid.
   */
  nodes?: PageNode[]
}

/**
 * Runs one operation against the frame named in `ref`.
 *
 * Also decides whether the result invalidates the model's view of the page.
 * Anything that can trigger navigation or reveal new content marks the page
 * stale, which is what stops the agent clicking confidently into a page it has
 * not seen.
 */
export async function execOp(tabId: number, op: AgentOp): Promise<ExecOutcome> {
  const target = resolveOpTarget(op)

  // A frame-free op (scroll/key/read/wait) goes to the top frame.
  const frameId = target?.frameId ?? 0
  const wire = target ? { ...op, ref: target.localRef } : op

  const reply = await askFrame<{
    result: { ok: boolean, message: string, error?: string }
    nodes?: PageNode[]
  }>(tabId, frameId, { type: 'frame/exec', op: wire, frameId, budget: READ_BUDGET })

  if (!reply.ok) {
    /*
     * Distinguish "nobody answered" from "the page said no". The first is what a
     * navigation looks like, and the agent should re-read the page; the second is
     * the page telling us something specific — a stale reference, an element that
     * is not a checkbox — and re-reading is the wrong response to most of those.
     */
    const navigated = reply.error === NO_ANSWER
    return {
      ok: false,
      message: navigated
        ? 'That frame is gone, which usually means the page navigated. Read the page again.'
        : reply.error,
      error: reply.error,
      stale: navigated,
    }
  }

  /*
   * Validate the reply rather than trusting it.
   *
   * The content script always sends `result`, but a frame running an *older*
   * copy can send anything: reloading the extension leaves the existing tabs'
   * content scripts in place until they navigate, so a background can find
   * itself talking to a script from the previous version. Assuming the shape and
   * reading `result.ok` off `undefined` throws a TypeError, which surfaces to the
   * user as "Cannot read properties of undefined" and ends the run with no
   * explanation of what actually went wrong.
   */
  const result = reply.value?.result
  if (!result || typeof result.ok !== 'boolean') {
    return {
      ok: false,
      message:
        'That page is running an older copy of WebPilot, so the action could not be carried out. ' +
        'Reload the page to pick up the current version.',
      error: 'stale content script',
      stale: false,
    }
  }

  return {
    ok: result.ok,
    message: result.message,
    error: result.error,
    stale: shouldMarkStale(op, result.ok),
    nodes: reply.value.nodes ? prefixNodes(reply.value.nodes, frameId) : undefined,
  }
}

function resolveOpTarget(op: AgentOp): { frameId: number, localRef: string } | null {
  const ref = (op as { ref?: string }).ref
  if (!ref) return null
  const m = /^f(\d+):(.+)$/.exec(ref)
  if (m) return { frameId: Number(m[1]), localRef: m[2] }
  // A bare `n12` is accepted and assumed to be the top frame, so a model that
  // drops the prefix still works.
  return { frameId: 0, localRef: ref }
}

/**
 * Whether the agent must re-read before its next action.
 *
 * Clicking almost always can reveal or remove things, so it counts. Typing does
 * not, unless it submitted — otherwise the model would re-read after every
 * keystroke group and burn its context on unchanged pages.
 */
function shouldMarkStale(op: AgentOp, ok: boolean): boolean {
  if (!ok) return false
  switch (op.op) {
    case 'click':
    case 'check':
    case 'select':
    case 'read':
      return true
    case 'type':
      return Boolean(op.submit)
    default:
      return false
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendering a snapshot for the model                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turns a snapshot into the text the model reads.
 *
 * Written as an outline rather than JSON: it is markedly cheaper in tokens, and
 * models attend to it more reliably because it looks like a page description
 * instead of a data structure they have to parse.
 */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines: string[] = []
  lines.push(`URL: ${snapshot.url}`)
  if (snapshot.title) lines.push(`Title: ${snapshot.title}`)

  const v = snapshot.viewport
  const scrolled =
    v.scrollY > 0 ? ` (scrolled ${Math.round((v.scrollY / Math.max(v.scrollHeight, 1)) * 100)}% down)` : ''
  lines.push(`Viewport: ${v.innerWidth}x${v.innerHeight}${scrolled}`)

  if (snapshot.frames.length > 1) {
    lines.push(`\nThis page has ${snapshot.frames.length} readable regions.`)
  }

  for (const frame of snapshot.frames) {
    const isTop = frame.frameId === 0
    lines.push('')
    lines.push(
      isTop
        ? `===== MAIN PAGE =====`
        : `===== EMBEDDED FRAME (f${frame.frameId}) — ${frame.url || 'no URL'} =====`,
    )

    if (frame.text) {
      lines.push(frame.text)
    } else if (!isTop) {
      lines.push('(no readable text)')
    }

    const flat = flatten(frame.nodes)
    if (flat.length) {
      lines.push('')
      lines.push(`--- interactive elements (${flat.length}) ---`)
      for (const node of flat) lines.push(renderNode(node))
    } else if (isTop) {
      lines.push('')
      lines.push('(this page exposes no interactive elements)')
    }
  }

  if (snapshot.unreadable.length) {
    lines.push('')
    lines.push(
      `--- frames that could not be read (${snapshot.unreadable.length}) ---`,
    )
    for (const frame of snapshot.unreadable) {
      lines.push(
        `- frame f${frame.frameId}: ${truncateUrl(frame.url)} — nothing could be read from it. ` +
          'Its contents are NOT available to you.',
      )
    }
    lines.push(
      'These are real parts of the page that you cannot see into — typically an embedded ' +
        'widget that had not loaded when the page was read. Do not invent actions against them. ' +
        'If the task needs them, call read_page again in case they have loaded since; if they ' +
        'are still empty, tell the user that part of the page is not reachable.',
    )
  }

  if (snapshot.truncated) {
    lines.push('')
    lines.push(
      'NOTE: this page was too large to read in full. Some text or elements were omitted. ' +
        'Scroll and read again to see more, or narrow your task.',
    )
  }

  return lines.join('\n')
}

function flatten(nodes: PageNode[]): PageNode[] {
  const out: PageNode[] = []
  const walk = (list: PageNode[], depth: number) => {
    for (const node of list) {
      out.push({ ...node, role: `${'  '.repeat(Math.min(depth, 3))}${node.role}`.trimStart() })
      if (node.children) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

function renderNode(node: PageNode): string {
  // An unnamed container legitimately has no name — `main`, a bare `nav` — and
  // rendering `""` for it is noise. Named containers keep their quoted name.
  const bits = [`[${node.id}]`, node.role]
  if (node.name) bits.push(JSON.stringify(node.name))
  if (node.value != null && node.value !== '') bits.push(`value=${JSON.stringify(node.value)}`)
  if (node.state?.length) bits.push(`(${node.state.join(', ')})`)
  if (node.href && node.role === 'link') bits.push(`→ ${truncateUrl(node.href)}`)
  if (node.hint) bits.push(`{${node.hint}}`)
  if (node.context) bits.push(`near: ${JSON.stringify(truncate(node.context, 100))}`)
  if (!node.inView) bits.push('[off-screen]')
  return `- ${bits.join(' ')}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Links to the same site are noise in full; keep the path, drop the origin. */
function truncateUrl(href: string): string {
  try {
    const u = new URL(href)
    const path = `${u.pathname}${u.search}`.replace(/\/$/, '')
    return path.length > 60 ? `${path.slice(0, 59)}…` : path || '/'
  } catch {
    return truncate(href, 60)
  }
}

/* -------------------------------------------------------------------------- */
/*  Screenshots                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Captures the visible tab and draws the agent's numbered boxes onto it.
 *
 * Off by default. It costs a round trip and a large image per step, and most
 * models that can call tools cannot see — but for a canvas app, a map, or a
 * site built out of absolutely-positioned divs, the picture is the only place
 * the page's actual structure exists.
 *
 * The capture has to happen here, because `captureVisibleTab` is a privileged
 * API. The *drawing* has to happen in the page, because an MV3 background script
 * has no DOM and therefore no `<canvas>`. So the screenshot makes a round trip:
 * background → top frame to annotate → back here.
 */
export async function captureAnnotated(
  tabId: number,
  windowId: number,
  marks: (Rect & { ref: string })[],
  viewport: ViewportInfo,
): Promise<string | null> {
  try {
    const dataUrl = await ext.tabs.captureVisibleTab(windowId, { format: 'png' })
    if (!marks.length) return dataUrl

    const annotated = await askFrame<{ dataUrl: string }>(tabId, 0, {
      type: 'frame/annotate',
      dataUrl,
      marks: marks.map((m) => ({ ...m, ref: m.ref.replace(/^f\d+:/, '') })),
      viewportWidth: viewport.innerWidth,
    })

    return annotated.ok ? annotated.value.dataUrl : dataUrl
  } catch {
    // Capture fails on a background tab, on some Android builds, and when the
    // window is not focused. The agent proceeds without the picture.
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Frame bookkeeping                                                          */
/* -------------------------------------------------------------------------- */

/** True when a ref belongs to a frame that no longer exists. */
export async function frameExists(tabId: number, frameId: number): Promise<boolean> {
  const frames = await listFrames(tabId)
  return frames.some((f) => f.frameId === frameId)
}