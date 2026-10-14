import * as React from 'react'

/**
 * Where portalled UI should be rendered.
 *
 * Radix components (tooltip, select, dialog) render through a portal that
 * defaults to `document.body`. That is correct for a normal page, and wrong for
 * the in-page overlay, which lives in a shadow root: anything portalled out to
 * the page's body escapes the shadow tree, and every style inside it — the whole
 * Tailwind preflight, the colour variables — stops applying. The result is an
 * unstyled tooltip floating in the page's own font.
 *
 * A panel that renders inside a shadow root provides that root here; the portal
 * consumers pick it up. Outside a provider the value is null, and Radix falls
 * back to its own default.
 */
export const PortalContainerContext = React.createContext<HTMLElement | null>(null)

export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext) ?? undefined
}