import { anatomyText, mammogramText, mriText } from './copy.generated'
import type { Case, CaseGroup, Modality, ModalityId, Panel, PanelId } from './types'

/** Build a modality entry, always with an empty keyFacts (global constraint). */
function modality(
  id: ModalityId,
  label: string,
  asset: string,
  viewPreset: string,
  text: string,
): Modality {
  return { id, label, asset, viewPreset, text, keyFacts: [] }
}

// ── Case catalogue ─────────────────────────────────────────
// The medical copy comes from ./copy.generated.ts.
//
// Modality sequences are driven by what the assets actually are (the md5
// audit in design doc §3.1):
//   · m2d.nrrd  4 files = 2 images, density A and D identical -> all dropped
//   · u2d.nrrd  5 files = 1 image, originally made for Cyst -> Cyst only
//   · GLBs exist only for density-1..4 -> every other case borrows one
//     (the five lesion cases all borrow density-3's, client feedback item 2)

/** The anatomy model every case without one of its own borrows. The client
 *  named the file to reuse: density-3/left/density75.glb. */
const SHARED_ANATOMY_GLB = 'density-3/left/density75.glb'
/** One preset for every anatomy slot -- there is only one in the catalogue. */
const ANATOMY_VIEW_PRESET = 'left_breast_view.json'

/** Build a slot. */
function panel(id: PanelId, label: string, modalities: Modality[]): Panel {
  return { id, label, modalities }
}

/**
 * Flattens `panels` into `modalities` so the two can never be written
 * separately and drift. Every case literal below goes through this.
 */
function buildCase(c: Omit<Case, 'modalities'>): Case {
  return { ...c, modalities: c.panels.flatMap(p => p.modalities) }
}

/** Shared builder for the density series: three slots, one directory layout. */
function densityCase(
  slug: string,
  dir: string,
  glb: string,
  title: string,
  heading: string,
  legacyKey: keyof typeof anatomyText,
): Case {
  return buildCase({
    slug,
    group: 'density',
    title,
    heading,
    panels: [
      panel('anatomy', 'Anatomy', [
        modality('anatomy', 'Anatomy', `${dir}/left/${glb}`, ANATOMY_VIEW_PRESET, anatomyText[legacyKey]),
      ]),
      panel('mammogram', 'Mammogram', [
        modality('mammogram', '3D Mammogram', `${dir}/middle/m3d.nrrd`, `${dir}/middle/m_view.json`, mammogramText[legacyKey]),
      ]),
      panel('mri', 'MRI', [
        modality('mri', '3D MRI', `${dir}/right/mri.nrrd`, `${dir}/right/mri_view.json`, mriText[legacyKey]),
      ]),
    ],
  })
}

/**
 * Single source of truth for how a case's `group` reads in the UI.
 *
 * Client feedback: "There are some minor consistency aspects". CaseHeader's
 * above-the-title eyebrow and CaseSidebar's nav-group heading used to type
 * this out independently -- 'Benign Condition' (singular) in one,
 * 'Benign Conditions' (plural) in the other -- and disagreed on every
 * benign case page. Both now read this one map, so they cannot drift apart
 * again; 'Benign Conditions' (plural, a group of cases) is the wording kept.
 * (CaseNav's prev/next overline was a third copy; it now names the slot
 * instead and no longer shows the group at all.)
 */
export const CASE_GROUP_LABEL: Record<CaseGroup, string> = {
  overview: 'Overview',
  density: 'Breast Density',
  benign: 'Benign Conditions',
  cancer: 'Breast Cancer',
}

/**
 * benign/cancer series.
 *
 * These now carry an anatomy slot (client feedback item 2: "The anatomy
 * section is missing from a few of the sections"). They have no GLB of
 * their own, so all five borrow density-3's -- the model the client
 * specified. Their anatomy copy is NOT new: `anatomyText` has carried
 * these five keys since the extraction, because the legacy app's left
 * panel displayed exactly this text on exactly these pages.
 */
function lesionCase(
  slug: string,
  group: 'benign' | 'cancer',
  dir: string,
  title: string,
  heading: string,
  lesionSliceIndex: number,
  legacyKey: keyof typeof mammogramText,
  withUltrasound = false,
): Case {
  const middle: Modality[] = [
    modality('mammogram', '3D Mammogram', `${dir}/middle/m3d.nrrd`, `${dir}/middle/m_view.json`, mammogramText[legacyKey]),
  ]
  if (withUltrasound) {
    // Second variant of the SAME slot, not a slot of its own: the reader
    // switches between them, 3D first. Only benign-cyst has a u2d.nrrd
    // (design doc §3.1's md5 audit).
    middle.push(
      modality('ultrasound', '2D Ultrasound', `${dir}/middle/u2d.nrrd`, `${dir}/middle/u_view.json`, mammogramText[legacyKey]),
    )
  }
  return buildCase({
    slug,
    group,
    title,
    heading,
    lesionSliceIndex,
    panels: [
      panel('anatomy', 'Anatomy', [
        modality('anatomy', 'Anatomy', SHARED_ANATOMY_GLB, ANATOMY_VIEW_PRESET, anatomyText[legacyKey]),
      ]),
      panel('mammogram', 'Mammogram', middle),
      panel('mri', 'MRI', [
        modality('mri', '3D MRI', `${dir}/right/mri.nrrd`, `${dir}/right/mri_view.json`, mriText[legacyKey]),
      ]),
    ],
  })
}

export const cases: Case[] = [
  buildCase({
    slug: 'the-breast',
    group: 'overview',
    title: 'The Breast',
    heading: 'The Breast',
    // Has no assets of its own; borrows density-1 throughout (design doc §4.4)
    panels: [
      panel('anatomy', 'Anatomy', [
        modality('anatomy', 'Anatomy', 'density-1/left/density25.glb', ANATOMY_VIEW_PRESET, anatomyText.normal),
      ]),
      panel('mammogram', 'Mammogram', [
        modality('mammogram', '3D Mammogram', 'density-1/middle/m3d.nrrd', 'density-1/middle/m_view.json', mammogramText.normal),
      ]),
      panel('mri', 'MRI', [
        modality('mri', '3D MRI', 'density-1/right/mri.nrrd', 'density-1/right/mri_view.json', mriText.normal),
      ]),
    ],
  }),

  densityCase('density-a', 'density-1', 'density25.glb', 'Density A', 'Almost entirely fat', 'density_1'),
  densityCase('density-b', 'density-2', 'density50.glb', 'Density B', 'Scattered fibroglandular densities', 'density_2'),
  densityCase('density-c', 'density-3', 'density75.glb', 'Density C', 'Heterogeneously dense', 'density_3'),
  densityCase('density-d', 'density-4', 'density100.glb', 'Density D', 'Extremely dense', 'density_4'),

  lesionCase('benign-cyst', 'benign', 'benign-cyst', 'Cyst', 'Cyst', 58, 'benign_cyst', true),
  lesionCase('benign-fibroadenoma', 'benign', 'benign-fib', 'Fibroadenoma', 'Fibroadenoma', 68, 'benign_fibroadenoma'),

  lesionCase('cancer-dcis', 'cancer', 'cancer-dcis', 'DCIS', 'DCIS', 90, 'cancer_dcis'),
  lesionCase('cancer-lobular', 'cancer', 'cancer-lobular', 'Lobular', 'Lobular', 80, 'cancer_lobular'),
  lesionCase('cancer-ductal', 'cancer', 'cancer-ductal', 'Ductal', 'Ductal', 27, 'cancer_ductal'),

  buildCase({
    // Copy and lesion index are both present, but there are no imaging
    // assets at all (design doc §4.4). Kept so the copy is not lost;
    // generates no route and no nav entry.
    slug: 'benign-calcifications',
    group: 'benign',
    title: 'Calcifications',
    heading: 'Calcifications',
    lesionSliceIndex: 0,
    disabled: true,
    panels: [],
  }),
]

export function enabledCases(): Case[] {
  return cases.filter(c => !c.disabled)
}

export function getCase(slug: string): Case | undefined {
  return cases.find(c => c.slug === slug)
}

export function getModality(slug: string, id: ModalityId): Modality | undefined {
  return getCase(slug)?.modalities.find(m => m.id === id)
}

/** The slot with this id, if the case has it. */
export function getPanel(c: Case, id: PanelId): Panel | undefined {
  return c.panels.find(p => p.id === id)
}

/**
 * Which slot holds `modalityId`, or undefined if this case has no such
 * modality. The URL carries a modality; the layout reasons in slots, and
 * this is the one place that translates.
 */
export function panelIdOf(c: Case, modalityId: ModalityId): PanelId | undefined {
  return c.panels.find(p => p.modalities.some(m => m.id === modalityId))?.id
}

/**
 * The modality `lesionSliceIndex` was measured on. See that field's doc:
 * it is the legacy `rightBoundingBoxIndex`, which only ever reached the
 * right-hand (MRI) panel.
 */
const LESION_MODALITY: ModalityId = 'mri'

/**
 * How many slices into `modality`'s volume this case's lesion sits, or 0 if
 * that question has no answer for this case/modality pair.
 *
 * Guards design doc §7.2's "Locate lesion" affordance. The number is an MRI
 * slice index and the volumes are not interchangeable: cancer-dcis's lesion
 * is at slice 90, but its mammogram volume is 39 slices deep (`sizes: 517
 * 1018 39` in the shipped NRRD header) and cancer-ductal's is 18 deep
 * against an index of 27. Offering to "locate the lesion" there would move
 * the slice plane to a position in a mammogram volume and label it as where
 * the lesion is -- which, in a resource that teaches people to read these
 * images, is worse than not offering it at all.
 */
export function lesionSliceIndexFor(c: Case, modality: ModalityId): number {
  return modality === LESION_MODALITY ? (c.lesionSliceIndex ?? 0) : 0
}

/**
 * Design doc §7.1's morph family: the four density levels plus `the-breast`,
 * which borrows density-1's GLB. `chooseTransition` (cameraTransitions.ts)
 * reads this predicate to decide which case navigations may crossfade
 * ('density-morph') rather than cut.
 *
 * Task 2 (three-up plan) gave every case one shared page key
 * (app/utils/pageKey.ts), not just this family, so membership here no
 * longer has anything to do with which cases share a renderer -- every case
 * does now, and residency is bounded by `sceneBudget.ts` instead. This
 * predicate is purely about which navigations are eligible to crossfade.
 */
export function isMorphFamilyGroup(group: CaseGroup): boolean {
  return group === 'density' || group === 'overview'
}
