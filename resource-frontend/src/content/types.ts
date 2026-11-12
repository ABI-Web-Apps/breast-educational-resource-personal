export type ModalityId = 'anatomy' | 'mammogram' | 'ultrasound' | 'mri'
export type CaseGroup = 'overview' | 'density' | 'benign' | 'cancer'

/**
 * A viewing slot, not an imaging technique.
 *
 * These are the legacy app's left/middle/right panels, which is also how
 * the assets are laid out on disk (`public/modelView/<case>/{left,middle,
 * right}/`) and how the copy tables are keyed (`leftPanelText` and friends
 * in the legacy app's data.js). A slot can hold more than one modality: the middle
 * slot of `benign-cyst` holds both the 3D mammogram and the 2D ultrasound,
 * which the reader switches between rather than seeing side by side.
 */
export type PanelId = 'anatomy' | 'mammogram' | 'mri'

export interface Panel {
  id: PanelId
  /** Slot label. Navigation text, not medical copy, so it may be adjusted. */
  label: string
  /** One or two. `[0]` is the default variant, always the 3D one. */
  modalities: Modality[]
}

export interface Modality {
  id: ModalityId
  /** UI label. Not medical copy, so it may be adjusted. */
  label: string
  /** Path relative to assetBase, e.g. "density-1/middle/m3d.nrrd" */
  asset: string
  /** copper3d view-preset JSON, relative to assetBase */
  viewPreset: string
  /** The medical copy for this modality. Never edited. */
  text: string
  /** Reserved by the schema (design doc §6.2). Always [] for now. */
  keyFacts: string[]
}

export interface Case {
  slug: string
  group: CaseGroup
  /** Short label for navigation */
  title: string
  /** Case heading */
  heading: string
  /**
   * Slice index holding the lesion, **in this case's MRI volume**. 0 or
   * absent means no specific lesion.
   *
   * Read `lesionSliceIndexFor(case, modality)` rather than this field
   * directly. The number is the legacy `rightBoundingBoxIndex`
   * (frontend/plugins/data.js:41), which was only ever read by the
   * right-hand panel and so only ever meant an MRI slice -- and the
   * mammogram volumes are far shallower, so using it there points at a
   * slice that does not exist. The schema keeps one value per case because
   * that is all the source data ever had; it is not one value per modality.
   */
  lesionSliceIndex?: number
  /**
   * The three viewing slots, always in `anatomy, mammogram, mri` order.
   * SOURCE OF TRUTH. `modalities` below is this, flattened.
   */
  panels: Panel[]
  /**
   * Every modality across every slot, flattened at construction time.
   *
   * Kept as a real field rather than a derived helper on purpose: it is
   * what the route table and `content/legacyRoutes.ts` read, and neither
   * should have to know that slots exist. `cases.test.ts` asserts the two stay equal.
   */
  modalities: Modality[]
  /** Has copy but no imaging assets: generates no route and no nav entry */
  disabled?: boolean
}
