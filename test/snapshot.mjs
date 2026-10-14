#!/usr/bin/env node
/**
 * Prints exactly what the model is shown for a page.
 *
 * The rendering in `page-bridge.ts` is the single highest-leverage piece of
 * prompt engineering in WebPilot — the model's next decision is shaped almost
 * entirely by how the page is described — and it is invisible in a test that
 * only asserts on the data structure. This shows the actual text.
 *
 * Run:  node test/snapshot.mjs
 */

import { makeFrame } from "./harness.mjs"

const PAGE = `
  <nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/search">Search</a>
  </nav>

  <main>
    <h1>Find a hotel in Lisbon</h1>
    <p>Enter your dates and we will show you what is available.</p>

    <form aria-label="Search hotels">
      <label for="city">City</label>
      <input id="city" type="search" value="Lisbon" placeholder="Where to?">

      <label for="checkin">Check in</label>
      <input id="checkin" type="date">

      <label for="guests">Guests</label>
      <select id="guests">
        <option>1 guest</option>
        <option selected>2 guests</option>
        <option>3 guests</option>
      </select>

      <label>
        <input type="checkbox" checked> Free cancellation only
      </label>

      <button type="submit">Search</button>
    </form>

    <iframe src="https://widgets.example.test/availability"></iframe>
  </main>

  <footer>
    <p>Prices include tax. © 2026</p>
    <a href="/terms">Terms</a>
  </footer>
`

const frame = makeFrame(PAGE)
const read = await frame.read()

/** Mirrors renderSnapshot in page-bridge.ts closely enough to eyeball. */
function render(node, indent) {
  const bits = [`[${node.id}]`, node.role]
  if (node.name) bits.push(JSON.stringify(node.name))
  if (node.value) bits.push(`value=${JSON.stringify(node.value)}`)
  if (node.state?.length) bits.push(`(${node.state.join(", ")})`)
  if (node.href && node.role === "link") bits.push(`→ ${node.href.replace("https://example.test", "")}`)
  if (node.hint) bits.push(`{${node.hint}}`)
  if (node.context) bits.push(`near: ${JSON.stringify(node.context.slice(0, 70))}`)
  if (!node.inView) bits.push("[off-screen]")
  let out = `${"  ".repeat(indent)}- ${bits.join(" ")}\n`
  for (const c of node.children ?? []) out += render(c, indent + 1)
  return out
}

console.log("=".repeat(72))
console.log(`URL: ${read.url}`)
console.log(`Title: ${JSON.stringify(read.title)}`)
console.log(`Viewport: ${read.viewport.innerWidth}x${read.viewport.innerHeight}`)
console.log("=".repeat(72))

console.log("\n--- visible text ---")
console.log(read.text)

console.log("\n--- interactive elements ---")
for (const n of read.nodes) process.stdout.write(render(n, 0))

console.log("\nscreenshot marks:", read.nodes.length ? "collected per element" : "none")
console.log("truncated:", read.truncated)
