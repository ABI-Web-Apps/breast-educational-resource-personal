<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useViewerStore } from '@/stores/viewer'
import AppHeader from '@/components/nav/AppHeader.vue'
import CaseSidebar from '@/components/nav/CaseSidebar.vue'
import TourLauncher from '@/components/tour/TourLauncher.vue'
import TourLayer from '@/components/tour/TourLayer.vue'
const store = useViewerStore()

// Tablet-only bottom-sheet pull state (design doc §10.2). Deliberately not
// in the Pinia store: see contentOpen's comment in stores/viewer.ts for why
// this needs to be its own field rather than reusing that one. Ephemeral by
// design -- a stale "expanded" carried across an unrelated navigation is a
// much smaller papercut than xl+'s content column defaulting collapsed.
const sheetExpanded = ref(false)

// The launcher and the header both start the tour; TourLayer owns the
// director, so both routes go through it. The layout itself owns neither.
const tourLayerRef = ref<{ startTour: () => void } | null>(null)
function startTour() { tourLayerRef.value?.startTour() }

// Gates the two tour components below; see the comment on their `v-if`.
// They read localStorage and measure the DOM, so they were never able to
// render on the server anyway -- this only changes HOW that is arranged.
const tourMounted = ref(false)
onMounted(() => { tourMounted.value = true })
</script>

<template>
  <!-- `ground` (not `bg-bg`) is what the app's glass has to sit on: the page
       colour plus three very low-alpha radials. See tokens.css. -->
  <div class="tw:ground tw:flex tw:h-dvh tw:flex-col tw:overflow-hidden">
    <!-- Skip link: first tab stop, hidden until focused. Below-xl the
         resident-looking sidebar is really 10+ off-canvas links a keyboard
         user would otherwise have to tab past on every single page. -->
    <a
      href="#main-content"
      class="tw:sr-only tw:focus:not-sr-only tw:focus:fixed tw:focus:left-2 tw:focus:top-2 tw:focus:z-50
             tw:focus:rounded-ctl tw:focus:bg-surface tw:focus:px-3 tw:focus:py-2 tw:focus:text-body-sm
             tw:focus:text-text tw:focus:shadow-md"
    >
      Skip to main content
    </a>

    <AppHeader data-tour-region @start-tour="startTour" />

    <div class="tw:flex tw:min-h-0 tw:flex-1">
      <!-- Case navigation: resident + collapsible at xl+ (§10.1); a drawer
           sliding in from the left at tablet (§10.2); a drawer dropping
           down from the top at phone (§10.3, "case navigation moves into a
           top drawer"). All three below-xl variants set `position: fixed`,
           which is the one invariant CaseSidebar's own focus-trap gate
           (`getComputedStyle(nav).position === 'fixed'`) relies on -- it
           doesn't care which edge the drawer comes from, only whether it's
           a drawer at all, so introducing the phone tier here doesn't
           require touching that gate. Neither below-xl tier nor xl+'s
           collapse ever sets `position` at xl+, so the gate stays false
           there in both the expanded and collapsed state, as it should --
           collapsing to 0 width isn't a modal, so it needs no trap, only a
           reachable reopen control (AppHeader's dedicated xl+ button,
           which lives outside this element entirely).

           `invisible`/`visible` (not just the transform/width) keeps a
           closed drawer's ~10 links, and a collapsed desktop panel's same
           links, out of the tab order and off-screen-reader -- a
           translated-off-screen or 0-width element is still focusable by
           default. The delay pairing lets the closing/collapsing
           transition finish before the panel actually goes
           non-interactive; opening/expanding reacts instantly. -->
      <CaseSidebar
        data-tour-region
        class="tw:max-md:fixed tw:max-md:inset-x-0 tw:max-md:top-14 tw:max-md:bottom-0 tw:max-md:z-30 tw:max-md:w-full
               tw:max-md:pane-lift tw:max-md:transition-[transform,visibility] tw:max-md:duration-200
               tw:md:max-xl:fixed tw:md:max-xl:top-14 tw:md:max-xl:bottom-0 tw:md:max-xl:left-0 tw:md:max-xl:z-30 tw:md:max-xl:pane-lift
               tw:md:max-xl:transition-[transform,visibility] tw:md:max-xl:duration-200
               tw:xl:transition-[width,visibility] tw:xl:duration-200"
        :class="[
          store.sidebarOpen
            ? 'tw:max-md:visible tw:max-md:translate-y-0 tw:max-md:delay-0 tw:md:max-xl:visible tw:md:max-xl:translate-x-0 tw:md:max-xl:delay-0'
            : `tw:max-md:invisible tw:max-md:-translate-y-full tw:max-md:delay-200
               tw:md:max-xl:invisible tw:md:max-xl:-translate-x-full tw:md:max-xl:delay-200`,
          store.sidebarExpanded
            ? 'tw:xl:visible tw:xl:delay-0'
            : 'tw:xl:invisible tw:xl:w-0 tw:xl:border-0 tw:xl:overflow-hidden tw:xl:delay-200',
        ]"
      />

      <!-- Drawer scrim, below xl only, while the drawer is open. Inset below
           the header (h-14 = the same 56px CaseSidebar reserves) so it dims
           the stage/content behind it without painting over the header --
           otherwise the header looks dimmed and "About"/the logo silently
           just close the drawer. Same scrim serves both the left drawer
           (tablet) and the top drawer (phone): both dim the same region. -->
      <button
        v-if="store.sidebarOpen"
        type="button"
        aria-label="Close case navigation"
        class="tw:fixed tw:inset-x-0 tw:top-14 tw:bottom-0 tw:z-20 tw:bg-text/20 tw:xl:hidden"
        @click="store.sidebarOpen = false"
      />

      <!-- Stage column (heading/stepper/stage/controls) and content column
           (case copy/prev-next) sit side by side at xl+; below it they
           stack in DOM order, which is already exactly design doc §10.3's
           required phone order (case heading -> stepper -> 1:1 stage ->
           control bar -> body copy -> prev/next) -- nesting each region in
           that order once and switching flex-direction per tier produces
           the right order at every tier without any CSS `order` juggling.

           md:max-xl:pb-20 reserves space for the tablet bottom sheet's own
           peek height (max-h-20 below): the sheet is `fixed bottom-0` and
           so is not part of this element's normal flow, and without this
           padding its last 80px permanently covers whatever the scrollable
           content ends on -- which will be Task 7's control bar. -->
      <main
        id="main-content"
        tabindex="-1"
        class="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-y-auto tw:md:max-xl:pb-20 tw:xl:flex-row tw:xl:overflow-hidden"
      >
        <!-- `data-stage-column` marks the fullscreen target for the control
             bar's ⛶ button (design doc §10.1): heading, stepper, stage and
             the bar itself, so the control that entered fullscreen is still
             on screen to leave it again. `ground` is load-bearing only in
             that state -- a fullscreened element with no background of its
             own shows the UA's black backdrop through it. It paints the
             same ground the layout root does, and because that utility is
             `background-attachment: fixed` the two align seamlessly rather
             than showing a seam down the middle. -->
        <!--
          `max-md:flex-none` is the phone fix, and it is not cosmetic.

          With `flex-1 min-h-0` this column is allowed to shrink below its own
          content, and in a column flex container whose height is the viewport
          it does exactly that. Measured at 414x896: the column's content was
          660px and flexbox gave it 461, so 199px -- the control bar included
          -- overflowed and was painted over by the content panel, which comes
          later in the DOM. Worse, the compression kept `main`'s scrollHeight
          equal to its clientHeight, so there was no scroll range at all and
          the body copy underneath was simply unreachable.

          `flex: none` restores `flex-basis: auto` with no shrink, so the
          column keeps its natural height, `main` becomes genuinely
          scrollable, and §10.3's single stacked column works the way it
          reads. Tablet and desktop keep `flex-1`: there the column really is
          meant to fill the space it is given.
        -->
        <div
          data-stage-column
          class="tw:ground tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col tw:max-md:flex-none"
        >
          <!-- Case heading (group label + title). -->
          <slot name="heading" />


          <!-- md:max-xl:min-h ensures the stage can't be squeezed to 0 at
               tablet: in a column flex layout with a shrink-0 sibling,
               flex-1 alone lets flex-basis 0 win once content pushes past
               the viewport height (negative free space defeats flex-grow).
               At phone, §10.3 asks for something stronger than a floor --
               an exact 1:1 square -- so aspect-square replaces flex-grow
               sizing there entirely (flex-none, so flex-grow can't fight
               the aspect ratio for the final height). Neither applies at
               xl+, which is a row layout instead. -->
          <section
            aria-label="3D case viewer"
            class="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:md:max-xl:min-h-100 tw:max-md:flex-none tw:max-md:aspect-square"
          >
            <slot name="stage" />
          </section>

          <!-- No `#controls` slot: each stage renders its own control bar
               directly under its own canvas, because the three-up layout
               gives every panel one. The slot existed only while a single
               bar had to sit beside a single stage. -->

        </div>

        <!-- Content column: collapsible width at xl+ (design doc §10.1's
             other collapsible panel, toggled from AppHeader); a pull-up
             bottom sheet at tablet (§10.2); plain inline flow at phone
             (§10.3 -- no sheet, no collapse, just the next region in the
             single column). The two xl+ width utilities and the two
             tablet max-height utilities are each mutually exclusive (never
             both present at once), so there's no same-variant specificity
             ambiguity between them.

             md:max-xl:z-10, below the drawer scrim's z-20: without this the
             sheet sat *above* the scrim, so it stayed undimmed and
             clickable while the case-nav drawer was supposedly modal. -->
        <div
          id="case-content-panel"
          data-tour-region
          class="tw:pane-flat tw:shrink-0 tw:border-border
                 tw:max-md:border-t
                 tw:md:max-xl:fixed tw:md:max-xl:inset-x-0 tw:md:max-xl:bottom-0 tw:md:max-xl:z-10 tw:md:max-xl:overflow-y-auto
                 tw:md:max-xl:rounded-t-card tw:md:max-xl:border tw:md:max-xl:pane-lift
                 tw:md:max-xl:transition-[max-height] tw:md:max-xl:duration-200
                 tw:xl:overflow-y-auto tw:xl:border-l tw:xl:transition-[width,visibility] tw:xl:duration-200"
          :class="[
            store.contentOpen
              ? 'tw:xl:w-100 tw:xl:visible tw:xl:delay-0'
              : 'tw:xl:w-0 tw:xl:border-0 tw:xl:overflow-hidden tw:xl:invisible tw:xl:delay-200',
            sheetExpanded ? 'tw:md:max-xl:max-h-[50dvh]' : 'tw:md:max-xl:max-h-20',
          ]"
        >
          <!-- Bottom-sheet handle, tablet only. Dragging it open needs a
               real pointer/touch gesture (a browser, not this test suite);
               tapping it is the keyboard- and gesture-free equivalent of
               "pull up to half-screen". min-h-11 (not the visually-smaller
               py-2 box it used to be) meets the 44px tap-target floor;
               bg-text-muted (not bg-border-strong, 1.73:1 on surface) meets
               the 3:1 non-text contrast floor for the handle's only visual
               affordance. -->
          <button
            type="button"
            class="tw:hidden tw:min-h-11 tw:w-full tw:items-center tw:justify-center tw:md:max-xl:flex"
            :aria-expanded="sheetExpanded"
            :aria-label="sheetExpanded ? 'Collapse content panel' : 'Expand content panel'"
            @click="sheetExpanded = !sheetExpanded"
          >
            <span class="tw:h-1 tw:w-10 tw:rounded-full tw:bg-text-muted" aria-hidden="true" />
          </button>

          <slot name="content" />

          <slot name="prevnext" />
        </div>
      </main>
    </div>

    <!--
      `v-if="tourMounted"`: both components read localStorage and measure
      the DOM, so they do not exist until this layout has mounted, and then
      they mount into its own stable subtree.

      History worth keeping: under the Nuxt build these were `.client`
      components, and Nuxt's client-only wrapper, on a COLD hydration,
      re-rendered an empty static vnode with no DOM node -- the next update
      patched against a null `el` and `[data-tour-layer]` never reached the
      document, so the guided tour could not open on any cold load. A plain
      mounted flag has none of that machinery.
    -->
    <template v-if="tourMounted">
      <TourLauncher @start="startTour" />
      <!-- expand-sheet: the tour's `description` step needs the tablet sheet
           open to point at content that is otherwise peeking at 80px. That
           state is local to this layout (see sheetExpanded's own comment), so
           it is handed down as a setter rather than moved into the store. -->
      <TourLayer ref="tourLayerRef" :expand-sheet="() => { sheetExpanded = true }" />
    </template>
  </div>
</template>
