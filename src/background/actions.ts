/**
 * Local-only actions the background performs on behalf of the settings UI.
 *
 * Split out from the router so the router stays about message plumbing. Nothing
 * here touches the page or the agent.
 */

import type { Settings } from '@/shared/settings'
import { listModels, testConnection } from './llm'

export { getModels, testSettings }

async function getModels(settings: Settings): Promise<{ ok: boolean, models: string[], error?: string }> {
  try {
    const models = await listModels(settings)
    return { ok: true, models }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function testSettings(settings: Settings): Promise<{
  ok: boolean
  message: string
  latencyMs?: number
  models?: string[]
}> {
  return testConnection(settings)
}