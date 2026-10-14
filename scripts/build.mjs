#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { build } from "vite"
import { ENTRIES, makeConfig, REQUIRED, root, STATIC } from "./vite-config.mjs"

const DIST = path.join(root, "dist")

async function copyStatic() {
  for (const rel of STATIC) {
    const from = path.join(root, rel)
    const to = path.join(DIST, rel)
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(from, to)
    } catch (err) {
      if (err.code === "ENOENT") {
        console.warn(`  ! missing static file: ${rel}`)
        continue
      }
      throw err
    }
  }
}

async function checkComplete() {
  const missing = []
  for (const rel of REQUIRED) {
    try {
      await fs.access(path.join(DIST, rel))
    } catch {
      missing.push(rel)
    }
  }
  if (missing.length) {
    console.error("\nBuild produced an incomplete extension. Missing:")
    for (const m of missing) console.error(`  - ${m}`)
    process.exit(1)
  }
}

async function dirSize(dir) {
  let total = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : (await fs.stat(p)).size
  }
  return total
}

async function run() {
  const started = Date.now()
  await fs.rm(DIST, { recursive: true, force: true })
  await fs.mkdir(DIST, { recursive: true })

  const sizes = []
  for (const spec of ENTRIES) {
    const t = Date.now()
    await build(makeConfig(spec))
    let size = 0
    try {
      size = (await fs.stat(path.join(DIST, `${spec.name}.js`))).size
    } catch {
      /* reported by the completeness check below */
    }
    sizes.push({ name: spec.name, size })
    console.log(
      `  ✓ ${spec.name.replace(/^src\//, "").padEnd(22)} ${String(Date.now() - t).padStart(5)}ms  ${(size / 1024).toFixed(0).padStart(4)} KB`,
    )
  }

  await copyStatic()
  await checkComplete()

  const bytes = await dirSize(DIST)
  console.log(`\nBuilt dist/ in ${Date.now() - started}ms (${(bytes / 1024).toFixed(0)} KB total)`)
  console.log("\nLoad it: about:debugging#/runtime/this-firefox → Load Temporary Add-on → dist/manifest.json")
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
