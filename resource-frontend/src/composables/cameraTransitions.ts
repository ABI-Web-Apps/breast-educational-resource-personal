import { isMorphFamilyGroup } from '@/content/cases'
import type { CaseGroup, ModalityId } from '@/content/types'

/**
 * Which transition a navigation gets. The interpolation math itself lives in
 * copper3d now (`ts/Controls/cameraTransitions.ts`); what stays here is the
 * one thing that depends on this catalogue's own content.
 */

export interface ViewKey {
  group: CaseGroup
  slug: string
  modality: ModalityId
}

export type Transition = 'density-morph' | 'modality-flight' | 'cut'

/**
 * Design doc §7.1: the density morph only triggers when switching between
 * density levels while staying on the Anatomy modality. `the-breast` borrows
 * density-1's GLB, so the `overview` group belongs to the same morph family
 * as `density`.
 *
 * Membership comes from `content/cases.ts` rather than being spelled out
 * here, so the two cannot drift apart.
 */
function inDensityFamily(v: ViewKey) {
  return isMorphFamilyGroup(v.group)
}

export function chooseTransition(from: ViewKey, to: ViewKey): Transition {
  if (from.slug === to.slug && from.modality === to.modality) return 'cut'

  if (
    from.modality === 'anatomy'
    && to.modality === 'anatomy'
    && inDensityFamily(from)
    && inDensityFamily(to)
  ) {
    return 'density-morph'
  }

  return 'modality-flight'
}
