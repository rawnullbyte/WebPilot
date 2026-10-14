#!/usr/bin/env node
/**
 * Tests for the frame agent — the code that reads a page and acts on it.
 *
 * This is the highest-risk part of WebPilot and the part least amenable to
 * reasoning from the source: whether a walk really reaches an element, whether a
 * shadow root is really descended into, whether a controlled input really ends
 * up with the value the framework will keep on its next render. Those are all
 * questions about emergent DOM behaviour, so they are tested against the real
 * shipped source in a real DOM (jsdom) rather than argued about.
 *
 * See test/harness.mjs for how the script is loaded and what jsdom does not
 * model.
 */

import assert from "node:assert/strict"
import { flatten, makeFrame, report, section, test } from "./harness.mjs"

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

section("reading")

await test("finds the page's controls", async () => {
  const f = makeFrame(`
    <h1>Sign in</h1>
    <form aria-label="Login">
      <label for="email">Email address</label>
      <input id="email" type="email" name="email">
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password">
      <button type="submit">Sign in</button>
    </form>
  `)
  const { nodes } = await f.flatNodes()
  assert.ok(nodes.length >= 4, `expected at least 4 nodes, got ${nodes.length}`)
})

await test("names a field from its <label>", async () => {
  const f = makeFrame(`
    <label for="email">Email address</label>
    <input id="email" type="email">
  `)
  const { nodes } = await f.flatNodes()
  const email = nodes.find((n) => n.name === "Email address")
  assert.ok(email, `not found; names were: ${nodes.map((n) => n.name).join(" | ")}`)
  assert.equal(email.role, "textbox")
})

await test("names a button from its own text", async () => {
  const f = makeFrame(`<button type="submit">Sign in</button>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].name, "Sign in")
  assert.equal(nodes[0].role, "button")
})

await test("names a link and reports its href", async () => {
  const f = makeFrame(`<a href="/forgot">Forgot your password?</a>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].role, "link")
  assert.equal(nodes[0].href, "https://example.test/forgot")
})

await test("assigns roles by input type", async () => {
  const f = makeFrame(`
    <input type="text" aria-label="Name">
    <input type="checkbox" aria-label="Agree">
    <input type="search" aria-label="Query">
    <select aria-label="Country"><option>AU</option></select>
    <textarea aria-label="Notes"></textarea>
    <input type="range" aria-label="Volume">
  `)
  const { nodes } = await f.flatNodes()
  const role = (name) => nodes.find((n) => n.name === name)?.role
  assert.equal(role("Name"), "textbox")
  assert.equal(role("Agree"), "checkbox")
  assert.equal(role("Query"), "searchbox")
  assert.equal(role("Country"), "combobox")
  assert.equal(role("Notes"), "textbox")
  assert.equal(role("Volume"), "slider")
})

await test("keeps a named form as the parent of its fields", async () => {
  const f = makeFrame(`
    <form aria-label="Login">
      <input aria-label="Email">
      <input aria-label="Password">
      <button>Go</button>
    </form>
  `)
  const { nodes } = await f.flatNodes()
  const form = nodes.find((n) => n.role === "form")
  assert.ok(form, "the form was not kept as a container")
  assert.ok(form.children?.length >= 3, `form has ${form.children?.length ?? 0} children`)
  for (const n of nodes.filter((x) => x.role === "textbox")) {
    assert.ok(n.depth > 0, "a form field was hoisted out of its form")
  }
})

await test("hoists bare layout wrappers so they do not become levels", async () => {
  const f = makeFrame(`
    <div><div><span><div>
      <button>Deep button</button>
    </div></span></div></div>
  `)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes.length, 1, `expected just the button, got ${nodes.length} nodes`)
  assert.equal(nodes[0].name, "Deep button")
  assert.equal(nodes[0].depth, 0, "the button should be at the top level after hoisting")
})

await test("drops a container that turned out to be empty", async () => {
  const f = makeFrame(`
    <form aria-label="Empty"></form>
    <button>Real</button>
  `)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].name, "Real")
})

await test("masks a password value", async () => {
  const f = makeFrame(`<input type="password" aria-label="Password" value="hunter2">`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].value, "••••••••", "a password value was sent to the model in the clear")
  assert.ok(nodes[0].state?.includes("password"))
})

await test("lists a select's options in its hint without making them nodes", async () => {
  const f = makeFrame(`
    <select aria-label="Country">
      <option>Australia</option>
      <option>Brazil</option>
    </select>
  `)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes.length, 1, "options should not be separate nodes")
  assert.match(nodes[0].hint ?? "", /Australia \| Brazil/)
})

await test("records the current value of a text field", async () => {
  const f = makeFrame(`<input aria-label="City" value="Lisbon">`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].value, "Lisbon")
})

await test("records a bounding box for screenshot annotation", async () => {
  const f = makeFrame(`<button>Boxed</button>`)
  const { nodes } = await f.flatNodes()
  assert.ok(nodes[0].rect, "no rect recorded, so screenshots would be unlabelled")
  assert.equal(nodes[0].rect.w, 200)
})

await test("marks an element out of view", async () => {
  const f = makeFrame(`<button>Far away</button>`)
  // Make the frame short so the element sits outside it.
  Object.defineProperty(f.window, "innerHeight", { value: 10, configurable: true })
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].inView, false)
})

await test("skips display:none controls", async () => {
  const f = makeFrame(`<button id="h">Hidden</button><button>Shown</button>`)
  f.markHidden(f.document.getElementById("h"))
  const { nodes } = await f.flatNodes()
  const names = nodes.map((n) => n.name)
  assert.ok(names.includes("Shown"))
  assert.ok(!names.includes("Hidden"), "a display:none button was reported")
})

await test("skips aria-hidden controls", async () => {
  const f = makeFrame(`<button aria-hidden="true">Decorative</button><button>Real</button>`)
  const { nodes } = await f.flatNodes()
  assert.ok(!nodes.map((n) => n.name).includes("Decorative"))
})

await test("finds a role=button div with no text", async () => {
  const f = makeFrame(`<div role="button" aria-label="Close dialog"></div>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].name, "Close dialog")
  assert.equal(nodes[0].role, "button")
})

await test("prefers aria-label over inner text", async () => {
  const f = makeFrame(`<button aria-label="Close">×</button>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].name, "Close")
})

await test("resolves aria-labelledby", async () => {
  const f = makeFrame(`
    <span id="lbl">Choose a date</span>
    <input aria-labelledby="lbl">
  `)
  const { nodes } = await f.flatNodes()
  assert.ok(nodes.some((n) => n.name === "Choose a date"), `got: ${nodes.map((n) => n.name)}`)
})

await test("reports an empty page without crashing", async () => {
  const f = makeFrame(``)
  const { frame, nodes } = await f.flatNodes()
  assert.deepEqual(nodes, [])
  assert.equal(frame.truncated, false)
})

await test("names a wrapping-label checkbox without mangling it", async () => {
  // A checkbox's default value is the string "on", which occurs inside
  // "cancellation" — an earlier version stripped the value out of the label and
  // produced "Free cancellati only". The name must be the label, untouched.
  const f = makeFrame(`<label><input type="checkbox" checked> Free cancellation only</label>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].name, "Free cancellation only")
})

await test("names a select by its label, not its options", async () => {
  // A select's textContent is every option concatenated, so reading text before
  // the label names a country picker "Australia Brazil Canada".
  const f = makeFrame(`
    <label for="g">Guests</label>
    <select id="g"><option>1 guest</option><option>2 guests</option></select>
  `)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].name, "Guests")
  assert.match(nodes[0].hint ?? "", /1 guest/)
})

await test("drops a list wrapper so its items are not nested pointlessly", async () => {
  const f = makeFrame(`<ul><li><a href="/x">Item</a></li></ul>`)
  const { nodes } = await f.flatNodes()
  assert.equal(nodes.length, 1, `expected just the link, got ${nodes.map((n) => n.role)}`)
  assert.equal(nodes[0].depth, 0)
})

await test("gives nearby text as context for an ambiguous control", async () => {
  const f = makeFrame(`
    <section>
      <h3>Refund policy</h3>
      <p>Read the full policy before proceeding.</p>
      <button>Select</button>
    </section>
  `)
  const { nodes } = await f.flatNodes()
  const button = nodes.find((n) => n.name === "Select")
  assert.ok(button, "the button was not found")
  assert.ok(button.context, "no context was gathered")
  assert.match(button.context, /Refund policy/)
})

/* -------------------------------------------------------------------------- */
/*  Shadow DOM                                                                 */
/* -------------------------------------------------------------------------- */

section("shadow DOM")

await test("descends into an open shadow root", async () => {
  const f = makeFrame(`<div id="host"></div>`)
  f.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
    `<button>Inside shadow</button><input aria-label="Shadow field">`
  const { nodes } = await f.flatNodes()
  const names = nodes.map((n) => n.name)
  assert.ok(names.includes("Inside shadow"), `shadow content was missed; found: ${names.join(", ")}`)
  assert.ok(names.includes("Shadow field"))
})

await test("treats a closed shadow root as opaque", async () => {
  const f = makeFrame(`<div id="host"></div><button>Outside</button>`)
  f.document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML =
    `<button>Unreachable</button>`
  const { nodes } = await f.flatNodes()
  const names = nodes.map((n) => n.name)
  assert.ok(names.includes("Outside"))
  assert.ok(!names.includes("Unreachable"), "a closed shadow root should be unreachable")
})

/* -------------------------------------------------------------------------- */
/*  Text extraction                                                            */
/* -------------------------------------------------------------------------- */

section("text")

await test("extracts visible prose", async () => {
  const f = makeFrame(`
    <h1>Refund policy</h1>
    <p>You may return any item within 30 days.</p>
  `)
  const frame = await f.read()
  assert.match(frame.text, /Refund policy/)
  assert.match(frame.text, /within 30 days/)
})

await test("excludes script, style and noscript contents", async () => {
  const f = makeFrame(`
    <p>Visible</p>
    <script>var secret = "should not appear";</script>
    <style>.x { color: red }</style>
    <noscript>Enable JS</noscript>
  `)
  const frame = await f.read()
  assert.match(frame.text, /Visible/)
  assert.ok(!/should not appear/.test(frame.text), "script source leaked into the page text")
  assert.ok(!/color: red/.test(frame.text), "stylesheet text leaked into the page text")
})

await test("excludes WebPilot's own UI from the page text", async () => {
  const f = makeFrame(`<p>Real content</p>`)
  const panel = f.document.createElement("div")
  panel.setAttribute("data-webpilot-ui", "overlay")
  panel.textContent = "Panel internals"
  f.document.body.appendChild(panel)
  const frame = await f.read()
  assert.match(frame.text, /Real content/)
  assert.ok(!/Panel internals/.test(frame.text), "the panel's own text was read as page content")
})

await test("separates adjacent inline elements", async () => {
  // Without this, a nav of links reads as "HomeSearchAccount" — the model sees
  // one word where the page has three links.
  const f = makeFrame(`
    <nav>
      <a href="/">Home</a>
      <a href="/s">Search</a>
      <a href="/a">Account</a>
    </nav>
  `)
  const frame = await f.read()
  assert.match(frame.text, /Home Search Account/, `got: ${JSON.stringify(frame.text)}`)
})

await test("separates labels from their fields", async () => {
  const f = makeFrame(`
    <label for="a">City</label><input id="a">
    <label for="b">Guests</label><input id="b">
  `)
  const frame = await f.read()
  assert.match(frame.text, /City\s+Guests/, `got: ${JSON.stringify(frame.text)}`)
})

await test("keeps a word together when markup splits it", async () => {
  // "<b>can</b>cel" is the word "cancel", not "can cel". Distinguishing this
  // from the adjacent-element case above is why the separator is deferred
  // rather than decided at the boundary.
  const f = makeFrame(`<p>You may <b>can</b>cel at any time.</p>`)
  const frame = await f.read()
  assert.match(frame.text, /You may cancel at any time/, `got: ${JSON.stringify(frame.text)}`)
})

await test("starts a new line at a block boundary", async () => {
  const f = makeFrame(`<p>First line</p><p>Second line</p>`)
  const frame = await f.read()
  assert.match(frame.text, /First line\nSecond line/, `got: ${JSON.stringify(frame.text)}`)
})

/* -------------------------------------------------------------------------- */
/*  Acting                                                                     */
/* -------------------------------------------------------------------------- */

section("acting")

await test("typing sets the value and fires input then change", async () => {
  const f = makeFrame(`<input aria-label="Field">`)
  const input = f.document.body.querySelector("input")
  const events = []
  input.addEventListener("input", () => events.push("input"))
  input.addEventListener("change", () => events.push("change"))

  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "type", ref: nodes[0].id, text: "hello", clear: true })

  assert.ok(res.ok, res.message)
  assert.equal(input.value, "hello")
  // Per character, then one `change`: this is what a person typing produces, and
  // frameworks that debounce or count keystrokes depend on it.
  assert.deepEqual(
    events,
    ["input", "input", "input", "input", "input", "change"],
    `unexpected event sequence: ${JSON.stringify(events)}`,
  )
})

await test("a controlled input's framework state ends up in step with the DOM", async () => {
  /*
   * The invariant that matters, modelled on how React actually works: it
   * installs its own `value` property that delegates to the native descriptor
   * and remembers the last value it saw, then re-reads on `input` to decide
   * whether anything changed. A native edit never calls the JS setter at all,
   * which is why real typing works on a controlled field and why a naive
   * `value =` assignment does not.
   *
   * So the assertion is not "which setter was used" — that is an implementation
   * detail — but "does the framework's notion of the value match what the user
   * now sees", which is the thing that was broken.
   */
  const f = makeFrame(`<input aria-label="Field" value="">`)
  const input = f.document.body.querySelector("input")
  const native = f.window.__nativeValueDescriptor(input)

  let frameworkValue = native.get.call(input)
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => native.get.call(input),
    set: (v) => native.set.call(input, v),
  })
  // React's re-read on input: whatever the engine ended up with is the truth.
  input.addEventListener("input", () => {
    frameworkValue = native.get.call(input)
  })

  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "type", ref: nodes[0].id, text: "reacted", clear: true })

  assert.ok(res.ok, res.message)
  assert.equal(
    frameworkValue,
    "reacted",
    "the framework's state did not follow the edit, so it would clear the field on its next render",
  )
  assert.equal(native.get.call(input), "reacted", "the field itself was not filled")
})

await test("typing commits the field by leaving it", async () => {
  /*
   * The regression guard for "the site doesn't see the text until I click away
   * and back". Plenty of forms read the value on `blur` rather than on `input`,
   * so a synthetic `change` is not enough — and a `focusout`/`blur` pair is what
   * actually leaving the field produces. Without this the field visibly holds
   * the text while the site still treats it as empty.
   */
  const f = makeFrame(`<input aria-label="Field">`)
  const input = f.document.body.querySelector("input")
  const seen = []
  for (const type of ["focusout", "blur", "change"]) {
    input.addEventListener(type, () => seen.push(type))
  }

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "hello", clear: true })

  assert.ok(seen.includes("focusout"), `focusout never fired; saw ${JSON.stringify(seen)}`)
  assert.ok(seen.includes("blur"), `blur never fired; saw ${JSON.stringify(seen)}`)
  assert.ok(
    seen.indexOf("change") < seen.indexOf("blur"),
    "change must come before blur, as it does when a person leaves a field",
  )
})

await test("a site that reads the value on blur gets the typed text", async () => {
  // Models the exact shape of the bug: state that only updates when left.
  const f = makeFrame(`<input aria-label="Field">`)
  const input = f.document.body.querySelector("input")
  let siteValue = ""

  input.addEventListener("blur", () => {
    // Some code reaches for the attribute rather than the property.
    siteValue = input.value
  })

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "committed", clear: true })

  assert.equal(siteValue, "committed", "the site still saw an empty field after typing")
})

await test("typing produces one keydown and keyup per character", async () => {
  /*
   * Search boxes that debounce, autocomplete, and anything counting characters
   * see nothing from a single bulk assignment — they need the keystrokes. This
   * is what a person typing produces.
   */
  const f = makeFrame(`<input aria-label="Search">`)
  const input = f.document.body.querySelector("input")
  const keys = []
  input.addEventListener("keydown", (e) => keys.push(`down:${e.key}`))
  input.addEventListener("keyup", (e) => keys.push(`up:${e.key}`))

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "cat", clear: true })

  assert.deepEqual(
    keys,
    ["down:c", "up:c", "down:a", "up:a", "down:t", "up:t"],
    `unexpected keystrokes: ${JSON.stringify(keys)}`,
  )
})

await test("a debounced search sees each keystroke, not one jump", async () => {
  const f = makeFrame(`<input aria-label="Search">`)
  const input = f.document.body.querySelector("input")
  const snapshots = []
  input.addEventListener("input", () => snapshots.push(input.value))

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "abc", clear: true })

  assert.deepEqual(
    snapshots,
    ["a", "ab", "abc"],
    `a debounced handler would have seen ${JSON.stringify(snapshots)}`,
  )
})

await test("typing fires beforeinput, the signal editors commit on", async () => {
  /*
   * This is the regression guard for the bug where a filled field looked right
   * but the site never saw it. React-style trackers are satisfied by a synthetic
   * `input`; editors and `beforeinput`-driven frameworks are not. Only a real
   * edit through the browser's pipeline satisfies those, and that pipeline is
   * what emits `beforeinput`.
   */
  const f = makeFrame(`<input aria-label="Field">`)
  const seen = []
  const input = f.document.body.querySelector("input")
  input.addEventListener("beforeinput", (e) => seen.push(e.inputType))

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "hello", clear: true })

  assert.ok(
    seen.includes("insertText"),
    `no beforeinput was fired, so an editor would ignore the typing; saw: ${JSON.stringify(seen)}`,
  )
})

await test("a framework listening on beforeinput sees the typed text", async () => {
  // Models a rich editor: it keeps its own copy of the content and only updates
  // when the editing pipeline tells it to.
  const f = makeFrame(`<input aria-label="Field">`)
  const input = f.document.body.querySelector("input")
  let frameworkState = ""

  input.addEventListener("beforeinput", (e) => {
    // What the browser is about to insert.
    frameworkState = (frameworkState === "" ? "" : frameworkState) + (e.data ?? "")
  })

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "seen", clear: true })

  assert.equal(
    frameworkState,
    "seen",
    "a beforeinput-driven framework never received the text",
  )
})

await test("a cancelable beforeinput is respected", async () => {
  // An input mask refusing a character must not be overridden by writing the
  // value directly — that would defeat the page's own validation.
  const f = makeFrame(`<input aria-label="Digits only">`)
  const input = f.document.body.querySelector("input")
  input.addEventListener("beforeinput", (e) => {
    if (e.data && /\D/.test(e.data)) e.preventDefault()
  })

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "abc", clear: true })

  assert.equal(input.value, "", "a rejected keystroke was forced into the field anyway")
})

await test("falls back to direct assignment when the pipeline refuses", async () => {
  // `insertText` does nothing for `number`, `date`, `range` and `file`, so for
  // those the value has to be set directly or the field never fills.
  const f = makeFrame(`<input type="number" aria-label="Quantity">`)
  f.window.__execCommandWorks = false
  const input = f.document.body.querySelector("input")

  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "type", ref: nodes[0].id, text: "42", clear: true })

  assert.ok(res.ok, res.message)
  assert.equal(input.value, "42", "the fallback did not fill the field")
})

await test("does not overwrite a value the site reformatted", async () => {
  /*
   * A phone field that rewrites "5551234" as "555-1234" has clearly accepted the
   * input. Forcing the raw text back would undo the site's own formatting and
   * leave the field in a state its validation rejects.
   */
  const f = makeFrame(`<input aria-label="Phone">`)
  const input = f.document.body.querySelector("input")
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "")
    if (digits.length === 7) input.value = `${digits.slice(0, 3)}-${digits.slice(3)}`
  })

  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "5551234", clear: true })

  assert.equal(input.value, "555-1234", "the site's own formatting was overwritten")
})

await test("appending puts the new text after the existing content", async () => {
  const f = makeFrame(`<input aria-label="Query" value="hotels in ">`)
  const input = f.document.body.querySelector("input")
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "Lisbon", clear: false })
  assert.equal(input.value, "hotels in Lisbon")
})

await test("clearing replaces rather than appends", async () => {
  const f = makeFrame(`<input aria-label="Field" value="old">`)
  const input = f.document.body.querySelector("input")
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "new", clear: true })
  assert.equal(input.value, "new")
})

await test("appending keeps what was already there", async () => {
  const f = makeFrame(`<input aria-label="Field" value="one">`)
  const input = f.document.body.querySelector("input")
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "type", ref: nodes[0].id, text: "two", clear: false })
  assert.equal(input.value, "onetwo")
})

await test("typing into a contenteditable sets its text", async () => {
  const f = makeFrame(`<div contenteditable="true" aria-label="Rich"></div>`)
  const el = f.document.body.querySelector("div")
  const { nodes } = await f.flatNodes()
  assert.equal(nodes[0].role, "textbox")
  const res = await f.exec({ op: "type", ref: nodes[0].id, text: "typed in", clear: true })
  assert.ok(res.ok, res.message)
  assert.equal(el.textContent, "typed in")
})

await test("clicking fires exactly one click", async () => {
  const f = makeFrame(`<button>Go</button>`)
  let clicks = 0
  f.document.body.querySelector("button").addEventListener("click", () => clicks++)
  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "click", ref: nodes[0].id })
  assert.ok(res.ok, res.message)
  assert.equal(clicks, 1, `a plain onclick listener fired ${clicks} times`)
})

await test("clicking still fires a mousedown-only handler", async () => {
  // `el.click()` alone dispatches only `click`, so handlers bound to
  // `mousedown` — most drag, menu and canvas UIs — would never see it.
  const f = makeFrame(`<div role="button" aria-label="Menu">Menu</div>`)
  let downs = 0
  f.document.body.querySelector("div").addEventListener("mousedown", () => downs++)
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "click", ref: nodes[0].id })
  assert.equal(downs, 1, "the mousedown handler never fired")
})

await test("clicking fires pointer events too", async () => {
  const f = makeFrame(`<button>Go</button>`)
  const seen = []
  const btn = f.document.body.querySelector("button")
  for (const type of ["pointerdown", "pointerup", "mouseup"]) {
    btn.addEventListener(type, () => seen.push(type))
  }
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "click", ref: nodes[0].id })
  assert.deepEqual(seen.sort(), ["mouseup", "pointerdown", "pointerup"])
})

await test("selecting an option by its visible text", async () => {
  const f = makeFrame(`
    <select aria-label="Country">
      <option value="au">Australia</option>
      <option value="br">Brazil</option>
    </select>
  `)
  const select = f.document.body.querySelector("select")
  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "select", ref: nodes[0].id, value: "Brazil" })
  assert.ok(res.ok, res.message)
  assert.equal(select.value, "br")
})

await test("selecting an option by its value", async () => {
  const f = makeFrame(`<select aria-label="Country"><option value="br">Brazil</option></select>`)
  const select = f.document.body.querySelector("select")
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "select", ref: nodes[0].id, value: "br" })
  assert.equal(select.value, "br")
})

await test("a bad option reports what was available", async () => {
  const f = makeFrame(`<select aria-label="Country"><option>Australia</option></select>`)
  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "select", ref: nodes[0].id, value: "Atlantis" })
  assert.equal(res.ok, false)
  assert.match(res.message, /Australia/, "the model was not told what it could pick")
})

await test("set-ops report the state the page actually reached", async () => {
  const f = makeFrame(`<input type="checkbox" aria-label="Agree" checked>`)
  const box = f.document.body.querySelector("input")
  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "check", ref: nodes[0].id, checked: false })
  assert.ok(res.ok, res.message)
  assert.match(res.message, /Unchecked/i, `message was: ${res.message}`)
  assert.equal(box.checked, false)
})

await test("setting a control to the state it is already in does not click it", async () => {
  const f = makeFrame(`<input type="checkbox" aria-label="Agree" checked>`)
  let clicks = 0
  f.document.body.querySelector("input").addEventListener("click", () => clicks++)
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "check", ref: nodes[0].id, checked: true })
  assert.equal(clicks, 0, "an already-satisfied check was clicked, toggling it off and on")
})

await test("checking a non-checkbox is refused", async () => {
  const f = makeFrame(`<button>Not a box</button>`)
  const { nodes } = await f.flatNodes()
  const res = await f.exec({ op: "check", ref: nodes[0].id, checked: true })
  assert.equal(res.ok, false)
  assert.match(res.message, /not a checkbox/i)
})

await test("pressing Enter in a form submits it", async () => {
  const f = makeFrame(`<form><input aria-label="Search"></form>`)
  let submitted = 0
  f.document.body.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault()
    submitted++
  })
  const { nodes } = await f.flatNodes()
  const field = nodes.find((n) => n.role === "textbox")
  const res = await f.exec({
    op: "type",
    ref: field.id,
    text: "cats",
    clear: true,
    submit: true,
  })
  assert.ok(res.ok, res.message)
  assert.equal(submitted, 1, "the form did not submit on Enter")
})

await test("a page that preventDefaults Enter keeps its own behaviour", async () => {
  // Sites that implement their own search box cancel the key so the browser does
  // not submit the form; firing requestSubmit anyway would double-fire.
  const f = makeFrame(`<form><input aria-label="Search"></form>`)
  let submitted = 0
  const input = f.document.body.querySelector("input")
  input.addEventListener("keydown", (e) => e.preventDefault())
  void input
  f.document.body.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault()
    submitted++
  })
  const { nodes } = await f.flatNodes()
  const field = nodes.find((n) => n.role === "textbox")
  await f.exec({ op: "type", ref: field.id, text: "x", clear: true, submit: true })
  assert.equal(submitted, 0, "a cancelled Enter still submitted the form")
})

await test("hover fires the events a menu waits for", async () => {
  const f = makeFrame(`<div role="button" aria-label="Menu">Menu</div>`)
  const seen = []
  const el = f.document.body.querySelector("div")
  for (const type of ["mouseover", "mousemove", "pointerover"]) {
    el.addEventListener(type, () => seen.push(type))
  }
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "hover", ref: nodes[0].id })
  assert.deepEqual(seen.sort(), ["mousemove", "mouseover", "pointerover"])
})

await test("focus moves the active element", async () => {
  const f = makeFrame(`<input aria-label="Field">`)
  const { nodes } = await f.flatNodes()
  await f.exec({ op: "focus", ref: nodes[0].id })
  assert.equal(f.document.activeElement, f.document.body.querySelector("input"))
})

await test("scrolling and waiting report success", async () => {
  const f = makeFrame(`<p>content</p>`)
  assert.ok((await f.exec({ op: "scroll", direction: "down" })).ok)
  assert.ok((await f.exec({ op: "scroll", direction: "bottom" })).ok)
  const waited = await f.exec({ op: "wait", ms: 10 })
  assert.ok(waited.ok)
  assert.match(waited.message, /10/)
})

/* -------------------------------------------------------------------------- */
/*  Stale references                                                           */
/* -------------------------------------------------------------------------- */

section("references")

await test("an unknown ref is refused rather than guessed at", async () => {
  const f = makeFrame(`<button>One</button>`)
  await f.read()
  const res = await f.exec({ op: "click", ref: "n999" })
  assert.equal(res.ok, false)
  assert.match(res.message, /read the page again/i)
})

await test("a detached element is reported as gone", async () => {
  const f = makeFrame(`<button id="b">Gone</button>`)
  const { nodes } = await f.flatNodes()
  f.document.getElementById("b").remove()
  const res = await f.exec({ op: "click", ref: nodes[0].id })
  assert.equal(res.ok, false)
  assert.match(res.message, /no longer on the page/i)
})

await test("refs are re-issued by each reading", async () => {
  const f = makeFrame(`<button>A</button><button>B</button>`)
  const first = await f.flatNodes()
  const second = await f.flatNodes()
  assert.deepEqual(
    first.nodes.map((n) => n.id),
    second.nodes.map((n) => n.id),
    "refs should be stable while the page is unchanged",
  )
})

await test("an exec returns the outlines for the elements it just touched", async () => {
  // Refreshing on every action is what keeps the numbered overlay aligned with
  // the page; a stale set of outlines mislabels every box on screen.
  const f = makeFrame(`<button>Go</button>`)
  const { nodes } = await f.flatNodes()
  const reply = await f.ask({ type: "frame/exec", op: { op: "click", ref: nodes[0].id }, frameId: 0 })
  assert.ok(reply.nodes, "no refreshed outlines were returned")
  assert.equal(reply.nodes.length, 1)
})

report()