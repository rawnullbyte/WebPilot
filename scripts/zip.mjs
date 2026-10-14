#!/usr/bin/env node
/**
 * Packs `dist/` into a distributable archive.
 *
 * The zip must contain the extension at its *root*, not inside a `dist/`
 * directory — Firefox reads `manifest.json` from the top level of the archive,
 * and a nested one installs as an empty add-on with no error to explain why.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { root } from "./vite-config.mjs"

const run = promisify(execFile)
const DIST = path.join(root, "dist")

async function main() {
  await fs.access(path.join(DIST, "manifest.json")).catch(() => {
    console.error("dist/manifest.json is missing. Run `npm run build` first.")
    process.exit(1)
  })

  const { version, name } = JSON.parse(await fs.readFile(path.join(DIST, "manifest.json"), "utf8"))
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const out = path.join(root, `${slug}-${version}.zip`)

  await fs.rm(out, { force: true })

  // `-r` recurse, `-X` strip extra file attributes so the archive is
  // reproducible across machines, `.` so nothing is nested.
  await run("zip", ["-r", "-X", "-q", out, "."], { cwd: DIST })

  const { size } = await fs.stat(out)
  console.log(`  ${path.basename(out)}  ${(size / 1024).toFixed(0)} KB`)
  console.log(
    "\nSign it before distributing: https://extensionworkshop.com/documentation/publish/",
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
