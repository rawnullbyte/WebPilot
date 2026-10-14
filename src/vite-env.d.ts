/// <reference types="vite/client" />

/**
 * Vite resolves `?inline` on a CSS import to the stylesheet *as a string*
 * rather than emitting a file. The overlay relies on this to get its styles
 * into a shadow root without a fetch.
 */
declare module '*.css?inline' {
  const content: string
  export default content
}

/** `true` in development builds; replaced at build time via `define`. */
declare const __DEV__: boolean
