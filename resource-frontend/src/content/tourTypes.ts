import type { PanelId } from './types'

/** Which layout a step applies to. `both` is the default. */
export type TourLayoutScope = 'wide' | 'narrow' | 'both'

export type ChapterId = 'layout' | 'reading' | 'interacting' | 'lesion'

/** Declarative pre-step actions the director performs before showing a card. */
export type TourPrepare =
  | { kind: 'openSidebar' }
  | { kind: 'closeSidebar' }
  | { kind: 'expandSheet' }
  | { kind: 'focusPanel', panel: PanelId }

/** Choreographed demonstrations. Every one of these needs a stage. */
export type TourDemo =
  | { kind: 'focusPanel', panel: PanelId }
  | { kind: 'orbit', panel: PanelId, degrees: number, durationMs: number }
  | { kind: 'scrubSlices', panel: PanelId, durationMs: number }
  | { kind: 'locateLesion', panel: PanelId }

export interface TourChapter {
  id: ChapterId
  /** Shown on the rail. */
  label: string
}

export interface TourStep {
  id: string
  chapter: ChapterId
  /** First selector that matches wins. All missing -> the step is skipped. */
  target?: string[]
  layout?: TourLayoutScope
  title: string
  /** Copy for the demonstrated version. */
  body: string
  /** Copy for the degraded version. REQUIRED whenever `demo` is present. */
  bodyFallback?: string
  /** Navigate here first. */
  route?: string
  prepare?: TourPrepare[]
  demo?: TourDemo
  /** The panel whose stage must be ready before `demo` can run. */
  requiresStage?: PanelId
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center'
}
