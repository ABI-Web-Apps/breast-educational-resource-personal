import { describe, expect, it } from 'vitest'
import { cases, enabledCases, getCase, getModality, getPanel, isMorphFamilyGroup, lesionSliceIndexFor, panelIdOf } from '../src/content/cases'
import type { ModalityId } from '../src/content/types'

describe('case catalogue shape', () => {
  it('has 11 entries, 10 of them enabled', () => {
    expect(cases).toHaveLength(11)
    expect(enabledCases()).toHaveLength(10)
  })

  it('disables only benign-calcifications (copy exists, imaging does not)', () => {
    const disabled = cases.filter(c => c.disabled).map(c => c.slug)
    expect(disabled).toEqual(['benign-calcifications'])
  })

  it('has unique slugs', () => {
    const slugs = cases.map(c => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe('modality sequences match the asset audit (design doc §4.3)', () => {
  const expected: Record<string, ModalityId[]> = {
    'the-breast': ['anatomy', 'mammogram', 'mri'],
    'density-a': ['anatomy', 'mammogram', 'mri'],
    'density-b': ['anatomy', 'mammogram', 'mri'],
    'density-c': ['anatomy', 'mammogram', 'mri'],
    'density-d': ['anatomy', 'mammogram', 'mri'],
    // The five lesion cases gained an anatomy modality (client feedback
    // item 2): they borrow density-3's model, which is what the client
    // asked for, and their anatomy copy has existed in anatomyText since
    // the extraction -- the legacy app's left panel showed it.
    'benign-cyst': ['anatomy', 'mammogram', 'ultrasound', 'mri'],
    'benign-fibroadenoma': ['anatomy', 'mammogram', 'mri'],
    'cancer-dcis': ['anatomy', 'mammogram', 'mri'],
    'cancer-lobular': ['anatomy', 'mammogram', 'mri'],
    'cancer-ductal': ['anatomy', 'mammogram', 'mri'],
  }

  for (const [slug, ids] of Object.entries(expected)) {
    it(`${slug} -> ${ids.join(' / ')}`, () => {
      expect(getCase(slug)?.modalities.map(m => m.id)).toEqual(ids)
    })
  }
})

describe('placeholder assets are never referenced (design doc §3.1)', () => {
  const allAssets = cases.flatMap(c => c.modalities.map(m => m.asset))

  it('no m2d.nrrd anywhere — four files, two unique images', () => {
    expect(allAssets.filter(a => a.includes('m2d.nrrd'))).toEqual([])
  })

  it('u2d.nrrd only for benign-cyst — five files, one unique image', () => {
    const u2d = allAssets.filter(a => a.includes('u2d.nrrd'))
    expect(u2d).toEqual(['benign-cyst/middle/u2d.nrrd'])
  })
})

/**
 * Client feedback item 3: "I think we can remove BIRADS".
 *
 * Removing only the header badge would leave the sidebar showing four bare
 * letters, which ARE the BI-RADS grades and say nothing without the label.
 * The nav titles carry the word instead. `heading` is untouched -- it was
 * never a BI-RADS string.
 */
describe('BI-RADS is gone from the content model', () => {
  it('no case carries a biRads or referenceDensity field', () => {
    for (const c of cases) {
      expect(c).not.toHaveProperty('biRads')
      expect(c).not.toHaveProperty('referenceDensity')
    }
  })

  it('the density series is titled Density A..D in navigation', () => {
    expect(['density-a', 'density-b', 'density-c', 'density-d'].map(s => getCase(s)!.title))
      .toEqual(['Density A', 'Density B', 'Density C', 'Density D'])
  })

  it('the density headings are untouched', () => {
    expect(['density-a', 'density-b', 'density-c', 'density-d'].map(s => getCase(s)!.heading))
      .toEqual([
        'Almost entirely fat',
        'Scattered fibroglandular densities',
        'Heterogeneously dense',
        'Extremely dense',
      ])
  })
})

describe('lesion slice indices carry over from rightBoundingBoxIndex', () => {
  const expected: Record<string, number> = {
    'benign-cyst': 58,
    'benign-fibroadenoma': 68,
    'cancer-dcis': 90,
    'cancer-lobular': 80,
    'cancer-ductal': 27,
  }
  for (const [slug, index] of Object.entries(expected)) {
    it(`${slug} -> ${index}`, () => {
      expect(getCase(slug)?.lesionSliceIndex).toBe(index)
    })
  }

  it('density cases have no lesion', () => {
    for (const c of cases.filter(c => c.group === 'density')) {
      expect(c.lesionSliceIndex ?? 0).toBe(0)
    }
  })
})

/**
 * Fix round 1, Critical. `rightBoundingBoxIndex` was read in exactly one
 * place in the legacy app -- frontend/components/model/PanelControls.vue:100,
 * which is mounted only inside RightPane.vue, whose `start()` loads
 * `right/mri.nrrd`. It is an MRI slice number and has never meant anything
 * on any other modality.
 *
 * The shipped volumes make that concrete rather than theoretical: read
 * straight out of the NRRD headers under public/modelView, cancer-dcis's
 * mammogram is `sizes: 517 1018 39` (39 slices, MaxIndex 38) against a
 * lesion index of 90, and cancer-ductal's is 18 against 27. Offering "Locate
 * lesion" there would point at a place in a mammogram volume and label it as
 * where the lesion is.
 */
describe('the lesion slice index only applies to the modality it was measured on', () => {
  const lesionCases = enabledCases().filter(c => (c.lesionSliceIndex ?? 0) > 0)

  it('covers the five lesion cases and no others', () => {
    expect(lesionCases.map(c => c.slug)).toEqual([
      'benign-cyst', 'benign-fibroadenoma', 'cancer-dcis', 'cancer-lobular', 'cancer-ductal',
    ])
  })

  it('reports the index for MRI', () => {
    for (const c of lesionCases) {
      expect(lesionSliceIndexFor(c, 'mri')).toBe(c.lesionSliceIndex)
    }
  })

  it('reports zero for every non-MRI modality, including ones the case actually has', () => {
    for (const c of lesionCases) {
      for (const m of c.modalities) {
        if (m.id === 'mri') continue
        expect(lesionSliceIndexFor(c, m.id)).toBe(0)
      }
    }
  })

  it('reports zero for a case with no lesion at all', () => {
    expect(lesionSliceIndexFor(getCase('density-d')!, 'mri')).toBe(0)
    expect(lesionSliceIndexFor(getCase('the-breast')!, 'mri')).toBe(0)
  })
})

describe('keyFacts is reserved but empty (global constraint)', () => {
  it('every modality has an empty keyFacts array', () => {
    for (const c of cases) {
      for (const m of c.modalities) {
        expect(m.keyFacts).toEqual([])
      }
    }
  })
})

describe('lookup helpers', () => {
  it('getCase returns undefined for an unknown slug', () => {
    expect(getCase('nope')).toBeUndefined()
  })

  it('getModality resolves a known pair', () => {
    expect(getModality('density-d', 'mri')?.id).toBe('mri')
  })

  it('getModality returns undefined for a modality the case lacks', () => {
    expect(getModality('cancer-dcis', 'ultrasound')).toBeUndefined()
  })
})

/**
 * Fix round 1. The page key now shares one component instance -- and so one
 * WebGLRenderer and one scene cache -- across §7.1's morph family, because a
 * crossfade needs both models alive on one renderer and every morph trigger
 * is a case navigation. `chooseTransition` decides the same membership from
 * a `ViewKey`; both read this one predicate so they cannot drift apart and
 * leave the family sharing a renderer it no longer morphs within (or, worse,
 * morphing across a boundary the renderer is torn down at).
 */
describe('morph family membership', () => {
  it('is exactly the density series plus the overview case that borrows its model', () => {
    const family = enabledCases().filter(c => isMorphFamilyGroup(c.group)).map(c => c.slug)
    expect(family).toEqual(['the-breast', 'density-a', 'density-b', 'density-c', 'density-d'])
  })

  it('excludes every lesion case', () => {
    for (const c of enabledCases().filter(c => c.group === 'benign' || c.group === 'cancer')) {
      expect(isMorphFamilyGroup(c.group)).toBe(false)
    }
  })
})

/**
 * Client feedback item 6's foundation. The slots mirror the asset layout
 * (`left/ middle/ right/`) and the legacy app's three text tables. Only
 * the middle slot ever holds two modalities, and only for benign-cyst --
 * the one case with a `u2d.nrrd`.
 */
describe('panel slots', () => {
  it('every enabled case has exactly the three slots, in order', () => {
    for (const c of enabledCases()) {
      expect(c.panels.map(p => p.id)).toEqual(['anatomy', 'mammogram', 'mri'])
    }
  })

  it('modalities is exactly panels flattened -- the two must never drift', () => {
    for (const c of cases) {
      expect(c.modalities).toEqual(c.panels.flatMap(p => p.modalities))
    }
  })

  it('every slot holds at least one modality', () => {
    for (const c of enabledCases()) {
      for (const p of c.panels) {
        expect(p.modalities.length).toBeGreaterThan(0)
      }
    }
  })

  it('only benign-cyst has a two-modality slot, and it is the middle one', () => {
    for (const c of enabledCases()) {
      const multi = c.panels.filter(p => p.modalities.length > 1)
      if (c.slug === 'benign-cyst') {
        expect(multi.map(p => p.id)).toEqual(['mammogram'])
      }
      else {
        expect(multi).toEqual([])
      }
    }
  })

  it('the 3D modality is the default variant of the mammogram slot', () => {
    const middle = getPanel(getCase('benign-cyst')!, 'mammogram')!
    expect(middle.modalities.map(m => m.id)).toEqual(['mammogram', 'ultrasound'])
    expect(middle.modalities[0]!.label).toBe('3D Mammogram')
  })

  it('panelIdOf maps every modality back to the slot that holds it', () => {
    for (const c of enabledCases()) {
      for (const p of c.panels) {
        for (const m of p.modalities) {
          expect(panelIdOf(c, m.id)).toBe(p.id)
        }
      }
    }
  })

  it('panelIdOf returns undefined for a modality the case does not have', () => {
    expect(panelIdOf(getCase('cancer-dcis')!, 'ultrasound')).toBeUndefined()
  })
})

/** Client feedback item 2, stated as its own contract. */
describe('the lesion cases borrow density-3\'s anatomy model', () => {
  const lesionSlugs = [
    'benign-cyst', 'benign-fibroadenoma', 'cancer-dcis', 'cancer-lobular', 'cancer-ductal',
  ]

  for (const slug of lesionSlugs) {
    it(`${slug} has an anatomy modality pointing at density75.glb`, () => {
      const anatomy = getModality(slug, 'anatomy')
      expect(anatomy).toBeDefined()
      expect(anatomy!.asset).toBe('density-3/left/density75.glb')
      expect(anatomy!.viewPreset).toBe('left_breast_view.json')
    })
  }

  it('all five point at the same asset, so the file is shipped once', () => {
    const assets = new Set(lesionSlugs.map(s => getModality(s, 'anatomy')!.asset))
    expect(assets.size).toBe(1)
  })
})
