<script setup lang="ts">
import { computed } from 'vue'
import { enabledCases, getCase, panelIdOf } from '@/content/cases'
import type { Case, ModalityId, Panel } from '@/content/types'
import { MODALITY_INK } from '@/utils/modalityInk'
import AppLink from '@/navigation/AppLink.vue'

/**
 * Previous / next VIEW, at the foot of the content column.
 *
 * A stop is a case's slot, not a case: anatomy -> mammogram -> MRI, then on
 * to the next case's anatomy. The client asked for exactly this -- clicking
 * next should go to the next panel, so the only thing the reader has to do
 * is press next -- and each stop has its own paragraph in this column, so
 * pressing next now walks the whole resource, copy included.
 *
 * The 2D/3D variant is NOT a stop. That was settled earlier, in the same
 * words `PanelTabs` records: the reader switches between the 3D mammogram
 * and the 2D ultrasound rather than passing through one on the way to the
 * other. So a slot holding both is one stop, opening on its 3D default.
 *
 * Order comes from `enabledCases()` -- the same declaration order the
 * sidebar groups and renders, so the two navigations can never disagree.
 *
 * ## On the presentation
 *
 * The overline is the SLOT ("MRI"), in that modality's own ink; below it is
 * the case, as "Density A: Almost entirely fat". The slot leads because it
 * is what changes on two presses out of every three. The group label
 * ("Breast Density") used to be the overline and is gone from this card:
 * the page's own eyebrow and the sidebar both still show it, and it was the
 * one line here that never changed.
 *
 * Both `title` and `heading`, weighted apart rather than run together: the
 * density cases are titled with bare letters, so heading-only produced a
 * link whose entire label was the character "D", while title-only says
 * nothing about what "Density A" looks like. `caption` collapses to one of
 * them for the six cases where the two fields are the same string.
 */
const props = defineProps<{ slug: string, modalityId: ModalityId }>()

interface Stop {
  case: Case
  panel: Panel
  /** Every slot opens on its 3D default -- see the variant note above. */
  to: string
  ink: string
  /** The case's own words, or nothing when `title` already is them. */
  caption?: string
}

const stops = computed<Stop[]>(() =>
  enabledCases().flatMap(c => c.panels.map((panel) => {
    const modality = panel.modalities[0]!
    return {
      case: c,
      panel,
      to: `/${c.slug}/${modality.id}`,
      ink: MODALITY_INK[modality.id],
      caption: c.heading === c.title ? undefined : c.heading,
    }
  })),
)

const neighbours = computed<{ previous?: Stop, next?: Stop }>(() => {
  const here = getCase(props.slug)
  const panelId = here && panelIdOf(here, props.modalityId)
  if (!panelId) return {}

  const all = stops.value
  const at = all.findIndex(s => s.case.slug === props.slug && s.panel.id === panelId)
  // -1 cannot happen behind the page's `validate` guard, but an unknown
  // stop must degrade to "no neighbours" rather than wrapping around to the
  // ends of the list, which `at - 1` on -1 would do.
  if (at === -1) return {}
  return { previous: all[at - 1], next: all[at + 1] }
})
</script>

<template>
  <!-- A CONTAINER query, not `sm:`: this nav lives in the 400px content
       panel, where a viewport breakpoint forced two ~176px columns and
       broke long headings across three lines. -->
  <nav
    v-if="neighbours.previous || neighbours.next"
    data-tour="prev-next"
    aria-label="Previous and next view"
    class="tw:@container tw:border-t tw:border-border tw:px-6 tw:py-6"
  >
    <ul class="tw:grid tw:gap-3 tw:@[30rem]:grid-cols-2">
      <li v-if="neighbours.previous">
        <!-- A card (§11). An earlier boxed version was reverted for
             competing with the stage's control bar; each stage owns its
             own bar now, so nothing here is left to compete with. -->
        <AppLink
          :to="neighbours.previous.to"
          class="tw:group tw:flex tw:h-full tw:flex-col tw:rounded-card tw:border tw:border-border tw:bg-surface tw:p-4
                 tw:shadow-sm tw:transition-[box-shadow,border-color,transform] tw:duration-200
                 tw:hover:-translate-y-px tw:hover:border-border-strong tw:hover:shadow-md"
        >
          <span
            class="tw:flex tw:items-center tw:gap-1.5 tw:text-caption tw:font-bold tw:uppercase tw:tracking-[0.14em]"
            :class="neighbours.previous.ink"
          >
            <svg viewBox="0 0 24 24" class="tw:size-3 tw:transition-transform tw:group-hover:-translate-x-0.5" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="m15 5-7 7 7 7" />
            </svg>
            {{ neighbours.previous.panel.label }}
          </span>
          <!-- One text node, no whitespace between the two spans: they read
               as one sentence, "Density A: Almost entirely fat". -->
          <span class="tw:mt-1.5 tw:block tw:text-body-sm tw:leading-snug">
            <span class="tw:font-bold tw:text-text tw:transition-colors tw:group-hover:text-brand-hover">{{ neighbours.previous.case.title }}</span><span
              v-if="neighbours.previous.caption"
              class="tw:text-text-muted"
            >: {{ neighbours.previous.caption }}</span>
          </span>
        </AppLink>
      </li>

      <!-- Keeps "next" in the right-hand column when there is no
           "previous" (the very first stop). -->
      <li
        v-if="neighbours.next"
        :class="neighbours.previous ? '' : 'tw:@[30rem]:col-start-2'"
      >
        <AppLink
          :to="neighbours.next.to"
          class="tw:group tw:flex tw:h-full tw:flex-col tw:rounded-card tw:border tw:border-border tw:bg-surface tw:p-4
                 tw:text-right tw:transition-[box-shadow,border-color,transform] tw:duration-200
                 tw:hover:-translate-y-px tw:hover:border-border-strong tw:hover:shadow-sm"
        >
          <span
            class="tw:flex tw:items-center tw:justify-end tw:gap-1.5 tw:text-caption tw:font-bold tw:uppercase tw:tracking-[0.14em]"
            :class="neighbours.next.ink"
          >
            {{ neighbours.next.panel.label }}
            <svg viewBox="0 0 24 24" class="tw:size-3 tw:transition-transform tw:group-hover:translate-x-0.5" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
            </svg>
          </span>
          <span class="tw:mt-1.5 tw:block tw:text-body-sm tw:leading-snug">
            <span class="tw:font-bold tw:text-text tw:transition-colors tw:group-hover:text-brand-hover">{{ neighbours.next.case.title }}</span><span
              v-if="neighbours.next.caption"
              class="tw:text-text-muted"
            >: {{ neighbours.next.caption }}</span>
          </span>
        </AppLink>
      </li>
    </ul>
  </nav>
</template>
