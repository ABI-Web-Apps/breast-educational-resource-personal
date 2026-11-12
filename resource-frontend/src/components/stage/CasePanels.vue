<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch, watchEffect } from 'vue'
import { useViewerStore } from '@/stores/viewer'
import { getPanel, lesionSliceIndexFor, panelIdOf } from '@/content/cases'
import type { Case, ModalityId, PanelId } from '@/content/types'
import { useAppRouter } from '@/navigation/router'
import CopperStage from '@/components/stage/CopperStage.vue'
import PanelTabs from '@/components/stage/PanelTabs.vue'

/**
 * The three viewing slots.
 *
 * The client asked: "Is it possible to show the different panels: anatomy,
 * mammogram/ultrasound, MRI etc on the same page but if the width is too
 * small then it switches to the current approach where you have to click
 * next or switch panels manually?" -- with the reason that the old version
 * showed all three so a lecturer could look across them, while the rebuilt
 * one is more digestible because it shows one paragraph at a time.
 *
 * So: three canvases, one paragraph. Which paragraph follows the focused
 * slot.
 */
const props = defineProps<{ case: Case, modalityId: ModalityId }>()

const store = useViewerStore()
const { navigateTo } = useAppRouter()

/**
 * Which slot the URL's modality lives in. That slot is the focused one:
 * three-up rings it and shows its paragraph, one-up shows only it.
 */
const focusedPanel = computed<PanelId>(
  () => panelIdOf(props.case, props.modalityId) ?? 'anatomy',
)

/**
 * The non-default variant a slot is currently showing, if any.
 *
 * LOCAL state, deliberately not in the URL. The URL carries one modality
 * and that is the focused one, so a lecturer who puts the middle slot on 2D
 * ultrasound and then focuses the MRI would otherwise see the middle slot
 * snap back to 3D. The cost is that the combination does not survive a page
 * reload, which is the right trade against a query param that every
 * prerendered route and legacy redirect would have to learn about.
 */
const variants = ref<Partial<Record<PanelId, ModalityId>>>({})

watchEffect(() => {
  const panel = panelIdOf(props.case, props.modalityId)
  if (!panel) return
  // Seeded from the URL: arriving at /benign-cyst/ultrasound must put the
  // middle slot on 2D, not merely focus a slot still showing 3D.
  variants.value[panel] = props.modalityId
  // And remembered, so the next case opens on the same slot. The page's
  // own modality fallback reads this back.
  store.preferredPanel = panel
})

/** The modality a slot shows: its remembered variant if the case still
 *  offers it, otherwise the slot's 3D default. */
function modalityFor(id: PanelId) {
  const panel = getPanel(props.case, id)!
  const chosen = panel.modalities.find(m => m.id === variants.value[id])
  return chosen ?? panel.modalities[0]!
}

function focus(id: PanelId) {
  const target = modalityFor(id)
  if (target.id !== props.modalityId) navigateTo(`/${props.case.slug}/${target.id}`)
}

function onVariant(choice: { panel: PanelId, modality: ModalityId }) {
  variants.value[choice.panel] = choice.modality
  // Choosing a variant also focuses its slot: the URL always names the
  // focused modality, and there is exactly one URL.
  navigateTo(`/${props.case.slug}/${choice.modality}`)
}

/**
 * Staged loading.
 *
 * Three-up mounts three stages, and every one of them used to start
 * downloading at once -- 50.4MB on `/the-breast`, which borrows density-1.
 * The focused panel now has the connection to itself until it settles; the
 * other two follow. Same bytes, far less time before anything is usable.
 *
 * One-way latch WITHIN a case: once released, a panel is never gated again
 * for that case, or stepping between slots would re-stage on every step.
 * But `pageKey.ts` pins every case page to one constant key, so this
 * component never remounts across cases -- without re-arming the latch on
 * `props.case.slug` changing, only the very first case of a session ever
 * got staged loading, and every case after it (the common prev/next path)
 * started all three multi-megabyte downloads at once again.
 */
const released = ref(false)
function release() { released.value = true }

// Safety net: a stage whose load never settles (a hung connection, a
// renderer that never became ready) must not strand its siblings forever.
let safetyTimer: ReturnType<typeof setTimeout> | undefined
function armSafetyTimer() {
  clearTimeout(safetyTimer)
  safetyTimer = setTimeout(release, 15_000)
}

onMounted(armSafetyTimer)
onScopeDispose(() => clearTimeout(safetyTimer))

watch(() => props.case.slug, () => {
  released.value = false
  armSafetyTimer()
})

function loadEnabledFor(id: PanelId) {
  return released.value || id === focusedPanel.value
}
</script>

<template>
  <div class="tw:@container tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col">
    <!-- One-up only. Three-up labels each panel in place, so a strip there
         would name the same three things twice. -->
    <!-- Transparent, and no bottom rule: the strip sits on the ground above
         a stage that is now its own floating card, so a full-bleed white bar
         with a hairline under it would read as a second surface butting into
         the first. -->
    <!-- `data-tour-region` for the same reason the case heading carries one:
         the tour's `panel-tabs` step targets this strip, and it sits outside
         the panel grid below, so without it that step matched no region and
         dimmed the whole app. -->
    <PanelTabs
      :case="props.case"
      :active-panel="focusedPanel"
      :variants="variants"
      data-tour-region
      class="tw:shrink-0 tw:@[1000px]:hidden"
      @variant="onVariant"
    />

    <!--
      Three-up above a 1000px CONTAINER width, one-up below it.

      A container query, not a viewport breakpoint, and that is the point:
      the threshold is this column's width, so collapsing the sidebar and
      the content panel -- both already offered in the header, for exactly
      this projection case -- can promote a 1440px laptop into three-up. A
      viewport breakpoint could not. 1000px leaves each panel ~333px.

      Hiding is `hidden` (display:none), never `invisible`: a display:none
      element measures 0x0, and that measurement is the whole load gate
      inside CopperStage. Verified in Chromium -- observing a display:none
      element fires immediately at 0x0, and again with real dimensions when
      it is shown.
    -->
    <!--
      Three cards with real space between them, not three regions divided by
      a hairline. A 1px rule made the panels read as one surface arbitrarily
      cut up; gap plus a card edge each makes them read as three things being
      compared, which is what they are.
    -->
    <!-- Padded at every width now, not only at three-up. One-up used to run
         the stage edge to edge, so the biggest surface on screen butted into
         the sidebar and the content column with nothing but a hairline
         between them -- three flat regions, no depth. Inset, the stage reads
         as a slab floating on the ground, which is the whole point of
         putting the chrome in glass. -->
    <div
      data-tour="panels"
      class="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:px-3 tw:pb-3
             tw:@[1000px]:grid tw:@[1000px]:grid-cols-3 tw:@[1000px]:gap-3 tw:@[1000px]:p-3"
    >
      <div
        v-for="panel in props.case.panels"
        :key="panel.id"
        :data-panel="panel.id"
        :data-focused="panel.id === focusedPanel"
        data-tour-region
        :class="[
          // `flex-1` is load-bearing, not decoration. Without it this cell
          // has no height in the one-up (flex-column) arrangement, the
          // stage wrapper inside it resolves to 0, and copper3d's canvas --
          // sized to whatever it last measured -- spills out of the cell
          // and over its neighbours. `overflow-hidden` is the second half:
          // a canvas is not clipped by its parent unless something says so.
          'tw:relative tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-hidden tw:bg-surface',
          // A card at every width. One-up used to be edge to edge on the
          // grounds that a border there is just a box round the page; that
          // was true when the page had no ground worth seeing.
          'tw:rounded-card tw:border tw:shadow-sm tw:transition-shadow tw:duration-200',
          panel.id === focusedPanel
            // The WHOLE card is the highlight, not a tinted title strip: a
            // brand border all the way round plus a lift off the page, so
            // which canvas the paragraph on the right belongs to is
            // readable from across a lecture theatre.
            //
            // Four corner brackets were tried here instead, on the argument
            // that four corners are how a radiologist marks a region and
            // that it would echo the tour's own spotlight. It was wrong at
            // this scale: the mark works on a small target, but stretched to
            // the corners of a full panel card it reads as a frame that
            // failed to draw rather than as a reticle. A focus indicator has
            // to look finished before it looks clever.
            ? 'tw:flex tw:@[1000px]:border-brand tw:@[1000px]:ring-1 tw:@[1000px]:ring-brand tw:@[1000px]:shadow-lg'
            : 'tw:hidden tw:@[1000px]:flex tw:@[1000px]:border-border',
        ]"
        @focusin="focus(panel.id)"
        @pointerdown="focus(panel.id)"
      >
        <!-- Three-up only: the slot's own label, plus its variant control
             where it has one. One-up gets both from PanelTabs above. -->
        <div
          class="tw:hidden tw:items-center tw:gap-2 tw:border-b tw:px-3 tw:py-1.5 tw:@[1000px]:flex"
          :class="panel.id === focusedPanel
            ? 'tw:border-brand/30 tw:bg-brand-subtle'
            : 'tw:border-border tw:bg-surface'"
        >
          <span
            class="tw:text-caption tw:font-bold tw:uppercase tw:tracking-[0.12em]"
            :class="panel.id === focusedPanel ? 'tw:text-brand-hover' : 'tw:text-text-muted'"
          >
            {{ panel.label }}
          </span>
          <!--
            `.stop` on both, and it is load-bearing. The cell focuses itself
            on pointerdown/focusin, which navigates to whatever modality
            that slot is currently on -- so on an UNFOCUSED panel a click
            here fired two navigations, the focus one to the slot's current
            modality and the button's to the chosen one, and the first won.
            Clicking "2D" on the mammogram panel landed on 3D mammogram.
            `onVariant` navigates to the chosen modality, which focuses the
            slot anyway, so nothing is lost by suppressing it here.
          -->
          <span
            v-if="panel.modalities.length > 1"
            data-variant
            class="tw:ml-auto tw:flex tw:gap-1"
            @pointerdown.stop
            @focusin.stop
          >
            <button
              v-for="m in panel.modalities"
              :key="m.id"
              type="button"
              class="tw:rounded-chip tw:px-2 tw:py-0.5 tw:text-caption"
              :class="m.id === modalityFor(panel.id).id
                ? 'tw:bg-brand-subtle tw:font-bold tw:text-brand-hover'
                : 'tw:text-text-muted tw:hover:bg-surface-sunken'"
              :aria-pressed="m.id === modalityFor(panel.id).id"
              @click="onVariant({ panel: panel.id, modality: m.id })"
            >
              {{ m.label }}
            </button>
          </span>
        </div>

        <CopperStage
          :slug="props.case.slug"
          :group="props.case.group"
          :panel-id="panel.id"
          :panel-label="panel.label"
          :lesion-slice-index="lesionSliceIndexFor(props.case, modalityFor(panel.id).id)"
          :modality="modalityFor(panel.id)"
          :compact="true"
          :load-enabled="loadEnabledFor(panel.id)"
          @settled="release"
        />
      </div>
    </div>
  </div>
</template>
