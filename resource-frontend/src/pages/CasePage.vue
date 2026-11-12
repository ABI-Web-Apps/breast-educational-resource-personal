<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useViewerStore } from '@/stores/viewer'
import { getCase, getPanel } from '@/content/cases'
import type { ModalityId } from '@/content/types'
import CaseHeader from '@/components/content/CaseHeader.vue'
import ModalityText from '@/components/content/ModalityText.vue'
import CaseNav from '@/components/nav/CaseNav.vue'
import CasePanels from '@/components/stage/CasePanels.vue'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { useDocumentTitle } from '@/navigation/head'
import { providePageRoute } from '@/navigation/router'
import type { PageRoute } from '@/navigation/routes'

/**
 * There is no 404 guard in this file. The route table (navigation/routes.ts)
 * only ever resolves a path to this page for an enabled case, on EVERY
 * navigation -- which matters because App.vue pins this component's instance
 * to one key for all cases, so setup does not re-run when the case changes.
 * A setup-time check here would only ever see the first case of a session.
 */
const props = defineProps<{ route: PageRoute }>()
const route = computed(() => props.route)
providePageRoute(route)

const store = useViewerStore()

const slug = computed(() => String(route.value.params.slug))
const current = computed(() => getCase(slug.value))

/**
 * The modality on screen.
 *
 * When the URL names one, it wins. When it does not -- arriving at
 * `/density-c` from the sidebar -- it falls back to the slot the reader
 * last chose rather than always to the first one, so stepping through the
 * density grades to compare their MRIs does not land on anatomy four times.
 * If that slot's own default is somehow missing, the case's first modality
 * is the backstop.
 */
const modalityId = computed<ModalityId>(() => {
  const requested = route.value.params.modality as ModalityId | undefined
  const available = current.value!.modalities.map(m => m.id)
  if (requested && available.includes(requested)) return requested

  const preferred = getPanel(current.value!, store.preferredPanel)
  return preferred?.modalities[0]?.id ?? available[0]!
})

const modality = computed(
  () => current.value!.modalities.find(m => m.id === modalityId.value)!,
)

watchEffect(() => {
  store.caseSlug = slug.value
  store.modalityId = modalityId.value
})

useDocumentTitle(() => `${current.value!.heading} — ${modality.value.label} — Breast Educational Resource`)

/*
 * There is no `provideStageControls()` here any more, and no `#controls`
 * slot below.
 *
 * That seam existed for one reason, stated in the composable it used to
 * live in: the control bar sat in the layout's `#controls` slot, a SIBLING
 * of the stage slot, so the stage could not reach it and this page -- their
 * nearest common ancestor -- had to own the state between them. Each stage
 * now renders its own bar directly under its own canvas, because the
 * three-up layout gives every panel one. With the bar inside the component
 * that drives it, there is nothing left to bridge.
 */

/*
 * `lesionSliceIndex` is no longer computed here either: three-up shows
 * three modalities at once, so the "which slice holds this lesion" answer
 * is per-panel rather than per-page. `CasePanels` asks
 * `lesionSliceIndexFor` for each slot it renders.
 */

/*
 * There is deliberately NO next-modality prefetch here.
 *
 * Design doc §9.2 asked for one, and it was built and measured. It cannot
 * work for this catalogue: Chromium refuses to store a response above a few
 * megabytes in its HTTP cache, so the warm-up's bytes are thrown away and the
 * real load pays for them again. Measured on the generated site served with
 * GitHub Pages' own headers -- 10,972,779 bytes warmed, 10,972,779 bytes
 * downloaded again, `fromDiskCache: false`. Fifteen of the sixteen assets a
 * prefetch could target here are 7.7-50.8MB. See §9.2's measured correction.
 *
 * Per-modality lazy loading -- one modality on screen, one download -- is the
 * part of §9.2 that does hold, and it is what CopperStage already does.
 */
</script>

<template>
  <DefaultLayout>
    <!-- design doc §10.1's ASCII places the case heading atop the stage
         column (above the modality stepper), not in the content column. -->
    <template #heading>
      <!-- `data-tour-region` is load-bearing, not decoration. The tour's
           `case-heading` step targets this element, and theatre mode only
           spares a region that IS, CONTAINS or IS CONTAINED BY the target.
           Without the attribute here nothing matched, so that step dimmed
           the entire app to 30% and highlighted nothing -- see
           tour-demo.spec.ts's "every step highlights something". -->
      <div class="tw:p-6 tw:pb-0" data-tour="case-heading" data-tour-region>
        <CaseHeader :case="current!" />
      </div>
    </template>

    <!-- No `#stepper` slot: the slot strip is one-up-only chrome, so it
         lives inside CasePanels next to the layout decision that hides it
         at three-up, rather than in a sibling slot that cannot see it. -->

    <template #stage>
      <CasePanels :case="current!" :modality-id="modalityId" />
    </template>

    <template #content>
      <div class="tw:flex tw:flex-col tw:gap-6 tw:p-6">
        <ModalityText :modality="modality" />
      </div>
    </template>

    <template #prevnext>
      <CaseNav :slug="slug" :modality-id="modalityId" />
    </template>
  </DefaultLayout>
</template>
