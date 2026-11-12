import type { ModalityId } from '@/content/types'

/**
 * The colour each imaging modality is named in. Shared by the one-up tab
 * strip and the prev/next cards so "MRI" reads the same wherever it appears.
 */
export const MODALITY_INK: Record<ModalityId, string> = {
  anatomy: 'tw:text-anatomy-ink',
  mammogram: 'tw:text-mammogram-ink',
  ultrasound: 'tw:text-ultrasound-ink',
  mri: 'tw:text-mri-ink',
}
