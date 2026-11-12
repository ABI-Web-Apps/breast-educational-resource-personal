<script setup lang="ts">
import { computed } from 'vue'
import type { Case, ModalityId, PanelId } from '@/content/types'
import { MODALITY_INK } from '@/utils/modalityInk'
import AppLink from '@/navigation/AppLink.vue'
import { useAppRouter } from '@/navigation/router'

/**
 * The one-up slot strip.
 *
 * This is `ModalityStepper` re-keyed from modality to SLOT. The difference
 * matters for `benign-cyst`, whose middle slot holds both the 3D mammogram
 * and the 2D ultrasound: the reader switches between those two, so the
 * ultrasound is a variant inside the mammogram tab rather than a fourth tab
 * of its own. The client's words were: some pages have both a 2D and a 3D
 * mammogram; those are not both laid out, the reader switches between
 * them, and the 3D one comes up first.
 *
 * Three-up has no use for this: each panel is labelled in place there, so a
 * strip would name the same three things twice.
 */
const props = defineProps<{
  case: Case
  activePanel: PanelId
  /**
   * The non-default modality each slot is currently showing, if any. Owned
   * by `CasePanels`; read here so a tab links to the variant its slot is
   * actually on rather than always to the 3D default.
   */
  variants: Partial<Record<PanelId, ModalityId>>
}>()

const emit = defineEmits<{ variant: [{ panel: PanelId, modality: ModalityId }] }>()

const { navigateTo } = useAppRouter()

/**
 * Per-modality icon, carried over from `ModalityStepper` unchanged --
 * including `ultrasound`, which is still drawn, just inside the variant
 * control below rather than as a tab of its own. The matching ink token
 * lives in `MODALITY_INK`, shared with the prev/next cards.
 *
 * Each icon draws HOW THE IMAGE IS MADE, which is the one thing that
 * actually distinguishes the four. An earlier set was abstract geometry and
 * read as exactly that -- the human could not work out what any of the
 * three icons was meant to mean.
 *
 *   anatomy     a breast in profile against the chest wall -- the model
 *   mammogram   the same profile flattened between two compression plates
 *   ultrasound  a transducer and the sector it insonates
 *   mri         a stack of parallel slices through a volume
 *
 * All stroke, no fill, so they hold up at 16px and inherit the tab's own
 * colour without a second token.
 */
const ICON: Record<ModalityId, string[]> = {
  // A semicircle off a vertical chest wall, plus the nipple. Drawn as an
  // arc rather than a shallow bezier because the bezier came out as a play
  // triangle at 16px.
  anatomy: ['M4.5 3.5v17', 'M4.5 5.5a6.5 6.5 0 0 1 0 13', 'M11 12h3.5'],
  // The same breast, flattened between two compression plates -- which is
  // literally what a mammogram does to it, and reads against the anatomy
  // icon precisely because the two share a shape.
  mammogram: ['M3 6.5h18', 'M3 17.5h18', 'M4.5 9v6', 'M4.5 9c7 0 11 .9 11 3s-4 3-11 3'],
  // Transducer plus the sector it insonates. The sector is deliberately wide
  // and the arc inside it is what makes it read as a beam rather than as a
  // lampshade.
  ultrasound: ['M9.5 3h5v3.5h-5z', 'M9.5 6.5 4.5 19.5h15L14.5 6.5', 'M8 14.5a6.6 6.6 0 0 1 8 0'],
  mri: ['M12 3.5 3.5 8 12 12.5 20.5 8z', 'M3.5 12 12 16.5 20.5 12', 'M3.5 16 12 20.5 20.5 16'],
}

/** Each slot paired with the modality it is currently showing, so a tab's
 *  icon and link follow the reader's 3D/2D choice. */
const tabs = computed(() => props.case.panels.map((panel) => {
  const chosen = panel.modalities.find(m => m.id === props.variants[panel.id])
  return { panel, current: chosen ?? panel.modalities[0]! }
}))

/**
 * Left/right arrow keys move between SLOTS, not between modalities, so
 * `benign-cyst`'s 2D ultrasound is no longer a step the reader has to pass
 * through on the way to the MRI.
 */
function onKeydown(event: KeyboardEvent) {
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (delta === 0) return
  const index = props.case.panels.findIndex(p => p.id === props.activePanel)
  const next = props.case.panels[index + delta]
  if (!next) return
  event.preventDefault()
  const target = next.modalities.find(m => m.id === props.variants[next.id]) ?? next.modalities[0]!
  navigateTo(`/${props.case.slug}/${target.id}`)
}
</script>

<template>
  <!--
    A tab strip, not a numbered stepper: the order is conveyed by an `<ol>`
    read left to right with `aria-current="step"`, rather than by drawing
    numbers over it. The active tab is marked by weight, by the modality's
    own ink, and by a 2px rule on the container's bottom border, which is
    the quietest available way to say "you are here".
  -->
  <ol
    data-tour="panel-tabs"
    class="tw:flex tw:items-center tw:gap-1 tw:overflow-x-auto tw:px-4"
    aria-label="Imaging modalities"
    @keydown="onKeydown"
  >
    <!-- The underline is on the <li> because the 3D/2D control is the
         link's sibling, not its child. Nested inside the anchor it was
         invalid HTML, and hovering a button showed the link's URL in the
         browser status bar. -->
    <li
      v-for="t in tabs"
      :key="t.panel.id"
      class="tw:relative tw:flex tw:shrink-0 tw:items-center tw:transition-colors
             tw:after:absolute tw:after:inset-x-2 tw:after:bottom-0 tw:after:h-0.5 tw:after:rounded-t-full
             tw:after:bg-current tw:after:transition-opacity"
      :class="t.panel.id === props.activePanel
        ? [MODALITY_INK[t.current.id], 'tw:font-bold tw:after:opacity-100']
        // `hover:` on the inactive branch only. As a static class on the
        // link it also matched the active tab, so hovering it dropped its
        // modality ink back to plain text.
        : 'tw:text-text-muted tw:hover:text-text tw:after:opacity-0'"
    >
      <AppLink
        :to="`/${props.case.slug}/${t.current.id}`"
        class="tw:flex tw:min-h-12 tw:items-center tw:gap-2 tw:px-3 tw:text-body-sm"
        :aria-current="t.panel.id === props.activePanel ? 'step' : undefined"
      >
        <svg
          viewBox="0 0 24 24"
          class="tw:size-4 tw:shrink-0"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path v-for="d in ICON[t.current.id]" :key="d" :d="d" />
        </svg>

        <span class="tw:whitespace-nowrap">{{ t.panel.label }}</span>
      </AppLink>

      <!-- The 3D/2D control, on the active slot only. -->
      <span
        v-if="t.panel.id === props.activePanel && t.panel.modalities.length > 1"
        data-variant
        class="tw:-ml-1 tw:flex tw:gap-1 tw:pr-3"
      >
        <button
          v-for="m in t.panel.modalities"
          :key="m.id"
          type="button"
          class="tw:rounded-chip tw:px-2 tw:py-0.5 tw:text-caption"
          :class="m.id === t.current.id
            ? 'tw:bg-brand-subtle tw:font-bold tw:text-brand-hover'
            : 'tw:text-text-muted tw:hover:bg-surface-sunken'"
          :aria-pressed="m.id === t.current.id"
          @click="emit('variant', { panel: t.panel.id, modality: m.id })"
        >
          {{ m.label }}
        </button>
      </span>
    </li>
  </ol>
</template>
