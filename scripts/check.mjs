#!/usr/bin/env node
/**
 * Validates the built extension.
 *
 * Catches the class of mistake that TypeScript cannot see, because it lives in
 * the gap between the code and the manifest: a file the manifest names but the
 * build never emitted, a relative path in an extension page that resolves
 * nowhere, a `web_accessible_resource` that does not exist. Every one of these
 * produces an extension that installs cleanly and then silently does nothing,
 * which is the worst way for it to fail.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { root } from "./vite-config.mjs"

const DIST = path.join(root, "dist")
const errors = []
const warnings = []

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const manifestPath = path.join(DIST, "manifest.json")
  if (!(await exists(manifestPath))) {
    console.error("dist/manifest.json is missing. Run `npm run build` first.")
    process.exit(1)
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))

  /* ---------------------------------------------------------------------- */
  /*  Every path the manifest names must exist                               */
  /* ---------------------------------------------------------------------- */

  const referenced = []

  for (const script of manifest.background?.scripts ?? []) referenced.push(script)
  if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker)
  if (manifest.background?.page) referenced.push(manifest.background.page)

  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) referenced.push(js)
    for (const css of cs.css ?? []) referenced.push(css)
  }

  if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup)
  if (manifest.sidebar_action?.default_panel) referenced.push(manifest.sidebar_action.default_panel)
  if (manifest.options_ui?.page) referenced.push(manifest.options_ui.page)
  if (manifest.options_page) referenced.push(manifest.options_page)

  for (const res of manifest.web_accessible_resources ?? []) {
    for (const r of res.resources ?? []) {
      if (r.includes("*")) {
        warnings.push(`web_accessible_resources uses a glob: ${r}`)
        continue
      }
      referenced.push(r)
    }
  }

  for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
    referenced.push(rel)
    if (!/^\d+$/.test(size)) errors.push(`icons has a non-numeric size key: "${size}"`)
  }
  for (const [size, rel] of Object.entries(manifest.action?.default_icon ?? {})) {
    referenced.push(rel)
    if (!/^\d+$/.test(size)) errors.push(`action.default_icon has a non-numeric key: "${size}"`)
  }

  for (const rel of new Set(referenced)) {
    if (!(await exists(path.join(DIST, rel)))) {
      errors.push(`manifest references a file that was not built: ${rel}`)
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Relative links inside the extension's own pages                        */
  /* ---------------------------------------------------------------------- */

  const pages = [
    manifest.action?.default_popup,
    manifest.sidebar_action?.default_panel,
    manifest.options_ui?.page,
  ].filter(Boolean)

  for (const page of new Set(pages)) {
    const abs = path.join(DIST, page)
    if (!(await exists(abs))) continue

    const html = await fs.readFile(abs, "utf8")
    const dir = path.dirname(abs)

    for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
      const ref = m[1]
      if (/^(https?:|data:|#|\/)/.test(ref)) continue
      const target = path.resolve(dir, ref)
      if (!(await exists(target))) {
        errors.push(`${page} links to a missing file: ${ref}`)
      }
    }

    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
      warnings.push(`${page} has no viewport meta tag — it will not scale on a phone`)
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Manifest shape                                                         */
  /* ---------------------------------------------------------------------- */

  if (manifest.manifest_version !== 3) {
    errors.push(`expected manifest_version 3, found ${manifest.manifest_version}`)
  }

  /*
   * `background.persistent` is a Manifest V2 key. In MV3 the background is an
   * event page by definition, and Firefox rejects the property outright:
   *
   *   Error processing background: Property "persistent" is unsupported in
   *   Manifest Version 3
   *
   * A previous version of this check *required* it, on the reasoning that the
   * agent holds state across a run and should not be unloaded. That was wrong on
   * both counts: the key is not accepted, and being unloadable is not something a
   * manifest key can prevent. State has to survive a restart instead — see the
   * persistence in agent.ts.
   */
  if ('persistent' in (manifest.background ?? {})) {
    errors.push(
      'background.persistent is a Manifest V2 key and Firefox rejects it in MV3. ' +
        'An MV3 background is an event page; make state survive a restart instead.',
    )
  }

  if (!manifest.browser_specific_settings?.gecko?.id) {
    errors.push("browser_specific_settings.gecko.id is required to install in Firefox")
  }

  for (const perm of manifest.permissions ?? []) {
    const known = new Set([
      "storage", "tabs", "scripting", "webNavigation", "activeTab", "alarms",
      "contextMenus", "cookies", "notifications", "downloads", "idle", "menus",
      "webRequest", "unlimitedStorage", "clipboardWrite", "declarativeNetRequest",
    ])
    if (!known.has(perm)) {
      warnings.push(`unrecognised permission "${perm}" — check the spelling`)
    }
  }

  // The in-page panel is injected via `scripting.executeScript({ files })`, which
  // reads from the extension rather than the page. If anything is ever added to
  // web_accessible_resources it becomes probeable by every site the user visits,
  // so flag it as a deliberate decision rather than letting it slip in.
  const war = (manifest.web_accessible_resources ?? []).flatMap((r) => r.resources ?? [])
  if (war.length) {
    warnings.push(
      `web_accessible_resources exposes ${war.length} file(s) to every page: ${war.join(", ")}. ` +
        `Confirm that is intended — the overlay does not need it.`,
    )
  }

  // Firefox for Android cannot inject into pages listed here, and `file://` is
  // additionally gated behind a user setting. Worth surfacing because the
  // overlay is the only UI on Android.
  if (manifest.content_scripts?.some((cs) => (cs.matches ?? []).includes("<all_urls>"))) {
    warnings.push(
      "content_scripts match <all_urls>, which Firefox for Android does not let the user " +
        "grant for file:// URLs — the panel will not appear on local files there",
    )
  }

  /* ---------------------------------------------------------------------- */
  /*  Bundle sanity                                                          */
  /* ---------------------------------------------------------------------- */

  // The content script is injected into every frame of every page, so its size
  // is a cost the user pays on every navigation. React must not creep in.
  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) {
      const abs = path.join(DIST, js)
      if (!(await exists(abs))) continue
      const { size } = await fs.stat(abs)
      if (size > 120 * 1024) {
        warnings.push(
          `${js} is ${(size / 1024).toFixed(0)} KB and is injected into every page — ` +
            `check that no UI library leaked into it`,
        )
      }
      const src = await fs.readFile(abs, "utf8")
      if (/react/i.test(src) && /react-dom/i.test(src)) {
        errors.push(`${js} appears to bundle React; it must stay dependency-free`)
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Script paths injected by the background                                */
  /* ---------------------------------------------------------------------- */

  /*
   * `scripting.executeScript({ files: [...] })` names a file by string, so the
   * compiler cannot see it and a typo or a renamed build entry produces no error
   * at all — the injection simply fails at runtime. The visible symptom is a
   * button that does nothing, on the one platform (Firefox for Android) where
   * the injected panel is the only interface the user has.
   *
   * So: scan every built background/content bundle for string literals ending in
   * `.js` that look like extension-relative paths, and require each to exist.
   */
  const bundles = []
  const collect = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await collect(p)
      else if (entry.name.endsWith(".js")) bundles.push(p)
    }
  }
  await collect(DIST)

  const injectedPaths = new Set()
  for (const bundle of bundles) {
    const src = await fs.readFile(bundle, "utf8")
    for (const m of src.matchAll(/["'`](src\/[A-Za-z0-9_\-./]+\.js)["'`]/g)) {
      injectedPaths.add(m[1])
    }
  }

  for (const rel of injectedPaths) {
    if (!(await exists(path.join(DIST, rel)))) {
      errors.push(
        `a bundle references "${rel}", which was not built. Either the build entry ` +
          `was renamed or the reference is stale.`,
      )
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Report                                                                 */
  /* ---------------------------------------------------------------------- */

  for (const w of warnings) console.warn(`  warning  ${w}`)
  for (const e of errors) console.error(`  error    ${e}`)

  if (errors.length) {
    console.error(`\n${errors.length} error(s), ${warnings.length} warning(s).`)
    process.exit(1)
  }
  console.log(`\nExtension checks passed (${warnings.length} warning(s)).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})