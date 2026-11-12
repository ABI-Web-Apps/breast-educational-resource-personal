import type { SceneBudget } from './copperExtras'
import { createSceneBudget, defaultBudgetBytes } from './copperExtras'

/**
 * The one budget every stage shares.
 *
 * The budget itself lives in copper3d now (`ts/Renderer/sceneBudget.ts`);
 * what stays here is the decision to have a single shared one. Three-up means
 * three `useModalityScene` instances competing for the same device memory, so
 * a per-instance cap would be three caps and the device would see the sum.
 */

let shared: SceneBudget | undefined

export function getSceneBudget(): SceneBudget {
  if (!shared) {
    const memory = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined
    shared = createSceneBudget(defaultBudgetBytes(memory))
  }
  return shared
}
