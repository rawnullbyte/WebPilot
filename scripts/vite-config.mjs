import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

/**
 * WebPilot ships as several independent bundles rather than one, for three
 * reasons:
 *
 *  1. Firefox does not execute `content_scripts` as ES modules, so the frame
 *     agent and the overlay have to be classic scripts. An IIFE per entry is the
 *     only shape that satisfies every surface equally.
 *  2. Output names are fixed. The manifest and the hand-written extension pages
 *     reference `sidebar.js`, not `sidebar-a4f9c2.js`, so nothing has to be
 *     rewritten between builds — and the paths in the manifest stay readable.
 *  3. Each UI surface gets its own copy of React. That costs bytes but buys
 *     isolation: a crash in the overlay cannot take the sidebar with it, and
 *     neither can be poisoned by the host page's globals.
 *
 * The content-script bundle (`src/content/page.js`) deliberately pulls in no
 * React at all — it is injected into every page the user visits, so it must stay
 * as small as possible.
 */
export function makeConfig({ name, entry, outDir = "dist" }) {
  return {
    root,
    configFile: false,
    // Extension pages load from a chrome-extension:// origin with no public
    // path, so every asset URL must stay relative.
    base: "",
    publicDir: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      __DEV__: JSON.stringify(false),
    },
    resolve: {
      alias: { "@": path.join(root, "src") },
    },
    plugins: [react(), tailwindcss()],
    esbuild: { drop: ["debugger"] },
    build: {
      outDir,
      emptyOutDir: false,
      // Readable output. This extension runs with a great deal of access over
      // pages the user cares about, so it is meant to be auditable by whoever
      // installs it. Minifying would obscure more than it saves.
      minify: false,
      sourcemap: false,
      target: "firefox120",
      cssCodeSplit: false,
      cssMinify: false,
      lib: {
        entry: path.join(root, entry),
        formats: ["iife"],
        name: `WebPilot_${name.replace(/[^a-zA-Z0-9]/g, "_")}`,
        fileName: () => `${name}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          // Pin the emitted stylesheet's name so the extension pages can link it
          // directly, the same way they link the script.
          assetFileNames: (info) => {
            const original = info.names?.[0] ?? info.name ?? ""
            if (original.endsWith(".css")) return `${name}.css`
            return `assets/[name][extname]`
          },
        },
      },
    },
    logLevel: "warn",
  }
}

/**
 * Every entry, in build order.
 *
 * `name` is both the output basename and the path segment under `dist/`, so
 * `{ name: "src/sidebar/sidebar" }` produces `dist/src/sidebar/sidebar.js` and
 * `dist/src/sidebar/sidebar.css` — mirroring `src/` exactly, which keeps the
 * manifest easy to read.
 */
export const ENTRIES = [
  // The agent loop, the LLM client and the page bridge. Bundled into one file
  // rather than the seven the manifest used to list: MV3 background scripts all
  // share one global scope, so separate files only worked because nothing was
  // bundled at all. One IIFE is simpler and leaves no load-order trap.
  { name: "src/background/background", entry: "src/background/index.ts" },
  // Injected into every frame of every page. No React; must stay tiny.
  { name: "src/content/page", entry: "src/content/page.ts" },
  // The in-page panel. Injected on demand, so React is fine here.
  { name: "src/overlay/overlay", entry: "src/overlay/main.tsx" },
  { name: "src/sidebar/sidebar", entry: "src/sidebar/main.tsx" },
  { name: "src/options/options", entry: "src/options/main.tsx" },
  { name: "src/popup/popup", entry: "src/popup/main.tsx" },
]

/** Files copied verbatim into `dist/`, mirroring their `src/` path. */
export const STATIC = [
  "manifest.json",
  // Sets the light/dark class before the panel renders. Has to be a real file:
  // the extension CSP blocks inline <script> in extension pages.
  "src/shared/theme-boot.js",
  "src/sidebar/sidebar.html",
  "src/options/options.html",
  "src/popup/popup.html",
  "src/icons/icon-16.png",
  "src/icons/icon-32.png",
  "src/icons/icon-48.png",
  "src/icons/icon-96.png",
  "src/icons/icon-128.png",
]

/**
 * Artefacts the manifest and pages depend on. A missing one here is the most
 * common way an extension silently does nothing after install, so the build
 * fails loudly rather than shipping.
 */
export const REQUIRED = [
  "manifest.json",
  "src/background/background.js",
  "src/content/page.js",
  "src/shared/theme-boot.js",
  "src/overlay/overlay.js",
  "src/sidebar/sidebar.js",
  "src/sidebar/sidebar.html",
  "src/options/options.js",
  "src/options/options.html",
  "src/popup/popup.js",
  "src/popup/popup.html",
  "src/icons/icon-48.png",
]