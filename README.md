# WebPilot

An agent that drives a real browser tab using your own model.

Point it at any OpenAI-compatible endpoint — OpenAI, OpenRouter, Groq, Ollama, LM
Studio, vLLM, anything that speaks `/chat/completions` with tool calling — and it
will read the page you are looking at, including content inside iframes, and then
click, type, scroll and navigate on your behalf.

It runs on Firefox for desktop and Firefox for Android.

---

## Install

```bash
npm install
npm run build
```

Then load it:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. **Load Temporary Add-on…**
3. Choose `dist/manifest.json`.

On **Firefox for Android**, temporary add-ons are loaded from
`about:debugging` in the same way, but you must enable debug mode first: tap the
Firefox logo five times in **Settings → About Firefox**, then **Settings → Secret
settings → Install extension from file** and pick a `.zip` built by `npm run zip`.

A temporary add-on is removed when Firefox restarts. For a permanent install you
need to sign it — see [Packaging](#packaging).

## Configure

Open **Settings** (the gear in the panel, or `about:addons` → WebPilot →
Preferences) and fill in three things:

| Field | Example |
| --- | --- |
| Base URL | `https://api.openai.com/v1` |
| API key | `sk-…` |
| Model | `gpt-4o-mini` |

Presets are provided for the common providers. The base URL is normalised, so
pasting `api.openai.com` or a full `…/v1/chat/completions` both work.

Press **Test connection**. It makes one real request and reports whether the model
can call tools — which is the thing that actually matters and the thing small
local models most often cannot do. It will tell you plainly if the model is
unsuitable rather than failing later in a confusing way.

> **Your key never leaves the device.** It is stored in `storage.local` (not
> `sync`, so it is not uploaded to a Mozilla account) and sent only to the
> endpoint you named. WebPilot has no server and makes no other network requests.

### Running a local model

For Ollama, the browser will be refused unless it is told to allow the extension
as an origin:

```bash
OLLAMA_ORIGINS='*' ollama serve
ollama pull qwen2.5:7b      # a model that supports tool calling
```

LM Studio works out of the box on `http://localhost:1234/v1`. If the endpoint is
not reachable, the error message names the cause and the fix rather than saying
"failed to fetch".

## Using it

There are three surfaces, and they are the same interface in different chrome:

- **Sidebar** (desktop) — `Ctrl/Cmd+Shift+S`, or the toolbar button → *Open
  sidebar*. It stays open while you browse and survives navigation.
- **In-page panel** (Android, and any narrow window) — a bottom sheet. This is the
  only surface on Firefox for Android, which has no sidebar.
- **Toolbar popup** — a launcher. Type a task, and it hands off to the sidebar or
  panel, because a popup is destroyed the moment it loses focus.

Type what you want in plain language:

> Summarise this page in three bullets
> Fill in the sign-up form with test@example.com and pick the free plan
> Find the refund policy and tell me whether it covers change of mind

As it works, the panel shows a live timeline: every action it took and what came
back. Click any row to see the tool arguments and result. The element the agent
is about to act on is boxed in the page, so you can see where it is about to
click without the overlay burying the site under outlines.

### Queueing

Type your next request while a task is still running and it queues rather than
being refused — because the useful moment to think of the next thing is while the
current thing is still going. Queued prompts are listed above the input with a
number and a way to remove each one, and they run in order as soon as the current
task finishes. **Stop** clears the queue as well as the run.

### When a request stalls

If the endpoint accepts a request and then goes quiet — a model that crashed, an
overloaded server, a dropped connection — WebPilot abandons it after 90 seconds
of silence rather than waiting forever, and says so. The clock resets on every
chunk received, so a slow model that is still talking is never cut short; only a
silent one is.

### Chats are per tab

Each tab has its own conversation. Switch tabs and you switch chats — a task
running in one tab keeps running while you look at another, and coming back to it
shows it exactly where it was. The toolbar badge marks which tab is busy, so you
can see that from anywhere.

Conversations are written to disk as they happen, so they survive the browser
shutting the extension down. Firefox unloads an idle background script as a
matter of course, and without this a running task would come back as an empty
chat.

### Thinking

While the model works, a box above the transcript streams its reasoning and its
output as they arrive — the way the better chat apps do it. When the turn ends
the box folds into a collapsed **Thinking** disclosure sitting above the actions
it produced, so you can still read *why* it did something after the fact. Each
turn keeps its own, so a long run stays auditable rather than turning into a wall
of steps.

Only models that actually report their reasoning will show any. Turn the box off
in **Settings → Behaviour** if you would rather not have it.

### Approval

Set in **Settings → Behaviour**. Three modes:

| Mode | Behaviour |
| --- | --- |
| **Act freely** *(default)* | Never asks. Fastest. |
| **Ask when risky** | Acts freely, but pauses before anything that looks irreversible — submits, payments, deletions, sending. |
| **Ask every time** | Confirms every click and keystroke group. |

### Running your own code in pages

Off by default. Turn on **Settings → Behaviour → Allow JavaScript in pages** and
the agent gains an `evaluate` tool: it can run its own JavaScript in a page,
reading the DOM directly, pulling values out of a data attribute, or calling a
site's own API.

This is a different order of capability from clicking and typing — it can read
anything the page can read and call anything the page can call — which is why it
is off until you ask for it, and why the `risky` approval mode always pauses for
it. Runs isolated from the page by default; a `MAIN` world option reaches the
site's own globals when you explicitly want that.

The risky-action check is a heuristic on button labels and field context. It only
ever *raises* the amount of checking, so a miss means "no extra prompt", never "a
destructive action ran unchecked". It is a safety net, not a guarantee — read what
the agent is doing.

If the agent is blocked and asks a question, or needs approval, the run genuinely
suspends until you answer. An unanswered prompt fails closed: five minutes of
silence is treated as "no".

## What it will not do

- Captchas, login walls and payment steps. It stops and says what it needs rather
  than trying to get past them.
- Invent credentials, card numbers, addresses or any personal data. It uses only
  what you tell it in the conversation.
- File uploads, drag-and-drop, canvas gestures. These cannot be done reliably
  through the DOM, so they are not offered as tools — an agent that claims to do
  them fails confusingly instead.

## How it works

Each step, WebPilot sends the model a description of the page: the visible text,
and a numbered outline of every interactive element.

```
URL: https://example.com/hotels
Title: Find a hotel in Lisbon
Viewport: 1280x800

Find a hotel in Lisbon
Enter your dates and we will show you what is available.
City Check in Guests …

--- interactive elements (6) ---
- [f0:n0] navigation "Main"
  - [f0:n1] link "Home" → /
  - [f0:n2] link "Search" → /search
- [f0:n3] main
  - [f0:n4] form "Search hotels"
    - [f0:n5] searchbox "City" value="Lisbon" {search box}
    - [f0:n6] date "Check in" {date}
    - [f0:n7] combobox "Guests" value="2 guests" {options: 1 guest | 2 guests}
    - [f0:n8] button "Search"
```

The model replies by calling a tool — `click`, `type`, `select_option`, `scroll`
and so on — and WebPilot performs it and reports back what happened. The loop runs
until the model calls `finish`, or hits the step limit.

**Iframes are read too.** A form inside an embedded frame is a separate document,
so it gets its own prefix: `f3:n4` is element 4 in frame 3. The agent treats all
frames as one page, which is what lets it fill in an embedded checkout widget.

**Refs are re-issued on every read.** They are not held stable across page
mutations, because any attempt to track identity through arbitrary framework
re-renders ends up pointing at recycled nodes — and a confidently wrong ref is
worse than an honest "read the page again".

**Nothing is minified.** The extension runs with broad access to pages you care
about, so the build output is meant to be readable by whoever installs it.

## Privacy

- Page text and element outlines go to the endpoint you configured, and nowhere
  else.
- Password field values are never sent. They are replaced with `••••••••` before
  the page is described to the model.
- The agent's own panel is excluded from what it reads, so it never sees itself.
- No telemetry, no analytics, no remote code. Everything is in this repository.

## Development

```bash
npm run verify     # typecheck, tests, build, and validate the built extension
npm test           # content-script behaviour tests, in jsdom
npm run typecheck  # tsc only
npm run build      # emit dist/
npm run check      # validate dist/ against the manifest
npm run snapshot   # print what the model would be shown for a sample page
npm run icons      # regenerate the icon set (needs rsvg-convert)
npm run zip        # build and produce a distributable archive
```

`npm run snapshot` is the most useful of these when changing how pages are read:
it prints the exact text the model receives, which is where most behavioural
regressions show up.

### Layout

```
src/
  shared/       types, settings, and the panel↔background transport
  background/   the agent loop, LLM client, page bridge, message router
  content/      the frame agent — reads and acts on one frame
  overlay/      the in-page panel (shadow DOM)
  sidebar/      the desktop sidebar
  options/      the settings page
  popup/        the toolbar popup
  components/   React UI shared by all three surfaces
  styles/       one Tailwind v4 theme
scripts/        build, validation, icons, packaging
test/           jsdom tests and the snapshot preview
```

Four bundles, one per surface, each an IIFE with fixed output names so the
manifest and the extension pages can reference them directly. The content script
is deliberately dependency-free and small — it is injected into every frame of
every page you visit.

### Packaging

```bash
npm run zip
```

This writes `webpilot-<version>.zip`. Firefox will not install an unsigned
extension permanently, so to distribute one you need to sign it — either through
[addons.mozilla.org](https://addons.mozilla.org/developers/) or with
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
for self-distribution.

The `browser_specific_settings.gecko.id` in `manifest.json` is a placeholder;
change it to something you control before publishing.

## Licence

MIT