import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CaseNav from '../src/components/nav/CaseNav.vue'
import { enabledCases, getCase } from '../src/content/cases'
import type { ModalityId } from '../src/content/types'

/**
 * Client feedback: "when you click the next panel button, would be great to
 * go to the next panel (anatomy -> mammography -> MRI) ... then the only
 * thing the person needs to do is to press next".
 *
 * So a stop is a slot, not a case, and the last slot of one case is followed
 * by the first slot of the next.
 */

const AppLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

function render(slug: string, modalityId: ModalityId) {
  const wrapper = mount(CaseNav, {
    props: { slug, modalityId },
    global: { stubs: { AppLink: AppLinkStub } },
  })
  return wrapper.findAll('a').map(a => ({ to: a.attributes('href'), text: a.text() }))
}

describe('CaseNav steps through slots, then through cases', () => {
  it('moves to the next slot inside the case', () => {
    const [previous, next] = render('density-a', 'mammogram')
    expect(previous!.to).toBe('/density-a/anatomy')
    expect(next!.to).toBe('/density-a/mri')
  })

  it('crosses into the next case after the last slot', () => {
    const [previous, next] = render('density-a', 'mri')
    expect(previous!.to).toBe('/density-a/mammogram')
    expect(next!.to).toBe('/density-b/anatomy')
  })

  it('crosses back into the previous case\'s last slot', () => {
    const [previous, next] = render('density-b', 'anatomy')
    expect(previous!.to).toBe('/density-a/mri')
    expect(next!.to).toBe('/density-b/mammogram')
  })

  it('has no previous at the very first stop and no next at the very last', () => {
    const all = enabledCases()
    const first = render(all[0]!.slug, 'anatomy')
    expect(first).toHaveLength(1)
    expect(first[0]!.to).toContain('/mammogram')

    const last = all[all.length - 1]!
    const end = render(last.slug, 'mri')
    expect(end).toHaveLength(1)
    expect(end[0]!.to).toContain('/mammogram')
  })

  /**
   * The 2D/3D variant is a toggle, not a stop -- the same decision PanelTabs
   * records. benign-cyst's middle slot holds both, and next must pass
   * through it once, landing on the 3D default.
   */
  it('treats a two-modality slot as one stop, opening on 3D', () => {
    const [, next] = render('benign-cyst', 'anatomy')
    expect(next!.to).toBe('/benign-cyst/mammogram')
    // Arriving there via the ultrasound variant still steps on to the MRI,
    // not back through the slot it is already in.
    const [, fromVariant] = render('benign-cyst', 'ultrasound')
    expect(fromVariant!.to).toBe('/benign-cyst/mri')
  })

  it('labels each card with the slot it goes to, read from content', () => {
    const cards = render('density-a', 'mammogram')
    const labels = getCase('density-a')!.panels.map(p => p.label)
    expect(cards[0]!.text).toContain(labels[0])
    expect(cards[1]!.text).toContain(labels[2])
  })

  it('names the case as "title: heading"', () => {
    const [, next] = render('density-a', 'mri')
    expect(next!.text).toContain('Density B: Scattered fibroglandular densities')
  })

  /** Six of the nine cases have `title === heading` -- "Cyst: Cyst" is not
   *  a caption, it is a stutter. */
  it('says a case\'s name once when its title and heading are the same', () => {
    const [, next] = render('benign-cyst', 'mri')
    expect(next!.text).toContain('Fibroadenoma')
    expect(next!.text).not.toContain('Fibroadenoma: ')
  })
})
