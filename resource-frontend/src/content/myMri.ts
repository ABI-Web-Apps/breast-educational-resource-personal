/** Names for the finding colours the report and viewer use. */
const COLOUR_NAMES: Record<string, string> = {
  '#ff7043': 'orange',
  '#42a5f5': 'blue',
}

const FALLBACK_COLOUR = 'this colour'

export interface FindingColour { label: string, color: string }

/** "orange is Finding 1, blue is Finding 2", built from the findings' own colours. */
export function colourSentence(findings: FindingColour[]): string {
  return findings
    .map(f => `${COLOUR_NAMES[f.color.toLowerCase()] ?? FALLBACK_COLOUR} is ${f.label}`)
    .join(', ')
}

export const MY_MRI_COPY = {
  eyebrow: 'MY MRI',
  title: 'Your MRI scan',
  subline: (cohort: string) => `Patient ${cohort} · contrast phase 1`,
  loading: 'Loading your scan…',
  tryAgain: 'Try again',
  viewerHeading: '3D view',
  viewerLabel: 'Your MRI scan in 3D',
  viewerHint: 'drag · right-drag · scroll',
  viewerReset: 'Reset',
  viewerResetLabel: 'Reset the 3D view',
  viewerLegendLabel: 'Colour key',
  viewerNoMask: 'No marked areas for this scan.',
  viewerErrors: {
    scan: 'Your scan could not be loaded.',
    orientation: 'Your scan could not be shown, because its orientation could not be read.',
    mask: 'The marked areas could not be loaded.',
    stalled: 'Your scan took too long to load.',
    viewer: 'The 3D view could not start on this device.',
  },
  reportHeading: 'Report',
  reportLoading: 'Loading your report…',
  reportTitle: 'Your MRI report',
  reportNoFindings: 'No report is available for this scan.',
  reportOpen: 'Open report',
  reportDownload: 'Download',
  panelHeading: 'WHAT YOU\'RE SEEING',
  intro: 'This is your breast MRI, shown in 3D. The three grey planes are slices through your scan, one in each direction.',
  markedAreas: 'The coloured shapes are the areas your clinician marked.',
  colourMatch: (sentence: string) => `Each colour matches a finding in your report: ${sentence}.`,
  controlsLead: 'Drag to turn the view, right-drag to move it, and scroll to zoom.',
  controlsReset: 'Reset',
  controlsTail: 'puts it back.',
  reportNote: 'Your report is beside the 3D view. A dash (—) means that item has not been recorded. If anything is unclear, ask your clinician.',
} as const
