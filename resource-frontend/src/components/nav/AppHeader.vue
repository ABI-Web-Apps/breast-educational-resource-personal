<script setup lang="ts">
import { useViewerStore } from '@/stores/viewer'
import { useTourStore } from '@/stores/tour'
import AppLink from '@/navigation/AppLink.vue'
const store = useViewerStore()
const tour = useTourStore()
const emit = defineEmits<{ startTour: [] }>()
</script>

<template>
  <!-- `pane-flat`, not `bg-surface`: the header is one of the app's glass
       panes, so it lets the ground's tint through and carries the same
       specular top edge every other pane does. -->
  <!-- `max-md:gap-2`: at phone the wordmark is fighting for every pixel (see
       the AppLink below), and 4px per gap is 8px of it. Desktop keeps 12. -->
  <header
    class="tw:pane-flat tw:flex tw:h-14 tw:shrink-0 tw:items-center tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:max-md:gap-2 tw:max-md:px-3"
  >
    <!-- Mobile/tablet only: opens/closes the case-nav drawer. Below xl the
         drawer's presence is sidebarOpen's job; at xl+ the sidebar is
         resident and a separate button (below) collapses it instead --
         two fields, two controls, because one field can't have two correct
         defaults for two tiers with opposite "normal" states (see
         sidebarOpen's comment in stores/viewer.ts). -->
    <button
      type="button"
      class="tw:flex tw:size-11 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-ctl tw:text-text-muted tw:hover:bg-surface-sunken tw:xl:hidden"
      :aria-expanded="store.sidebarOpen"
      aria-controls="case-sidebar"
      aria-label="Toggle case navigation"
      @click="store.sidebarOpen = !store.sidebarOpen"
    >
      <svg viewBox="0 0 24 24" class="tw:size-5" aria-hidden="true">
        <path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z" />
      </svg>
    </button>

    <!-- Desktop-only (design doc §10.1): collapses the resident sidebar to
         0 width, the other half of "collapse both panels for projection". -->
    <button
      type="button"
      class="tw:hidden tw:size-11 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-ctl tw:text-text-muted tw:hover:bg-surface-sunken tw:xl:flex"
      :aria-expanded="store.sidebarExpanded"
      aria-controls="case-sidebar"
      aria-label="Toggle case navigation panel"
      @click="store.sidebarExpanded = !store.sidebarExpanded"
    >
      <svg viewBox="0 0 24 24" class="tw:size-5" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
        <line x1="9" y1="5" x2="9" y2="19" stroke="currentColor" stroke-width="2" />
      </svg>
    </button>

    <!--
      The wordmark carries BOTH names, te reo above English.

      It used to read "Te Uma" alone. `Te Uma` is te reo Māori for the breast
      and belongs on this app -- it is a New Zealand resource built with Iwi
      United Engaged -- but on its own it told a reader who does not speak te
      reo nothing at all about what they were looking at. Pairing the names is
      the ordinary treatment here, and it costs one line of 12px type.

      `leading-none` on both, so the pair occupies about the same height the
      single line did and the 56px header does not grow.

      THE TYPE STEP AT PHONE IS NOT COSMETIC. Measured on the running app:
      at 14px this title needs about 160px to set on two lines, and the
      wordmark is only given 90px at 360px wide and 120px at 390px -- so it
      broke onto THREE lines and, with the overline above it, overflowed the
      56px header. 12px brings "Breast Educational" back under the available
      width, and the step back up at 420px is where 14px starts fitting on
      two lines again. `min-w-0` is the other half: without it this flex item
      refuses to shrink below its content and pushes into the controls.
    -->
    <AppLink to="/" class="tw:flex tw:min-w-0 tw:items-center tw:gap-2.5 tw:max-md:gap-2">
      <span class="tw:size-2.5 tw:shrink-0 tw:rounded-full tw:bg-brand" aria-hidden="true" />
      <span class="tw:flex tw:min-w-0 tw:flex-col tw:gap-0.5">
        <span class="tw:text-caption tw:font-medium tw:leading-none tw:tracking-[0.14em] tw:text-text-muted">
          TE UMA
        </span>
        <span
          class="tw:text-[0.75rem] tw:font-bold tw:leading-[1.15] tw:tracking-tight tw:text-text
                 tw:min-[420px]:text-body-sm tw:min-[420px]:leading-tight tw:sm:text-h3 tw:sm:leading-none"
        >
          Breast Educational Resource
        </span>
      </span>
    </AppLink>

    <!--
      Right-hand header actions.

      `ml-auto` lives HERE and not on the first child, which is the fix for
      client feedback item 10. It used to sit on the content-panel toggle
      below, which is `hidden ... xl:flex`: below xl that button is
      display:none and its auto margin goes with it, so the About link had
      nothing pushing it right and rendered flush against the wordmark. An
      iPad Air (1180px) shows this; a desktop never does, because there the
      button exists. A wrapper that is present at every width cannot have
      that failure mode.
    -->
    <div data-header-actions class="tw:ml-auto tw:flex tw:shrink-0 tw:items-center tw:gap-3 tw:max-md:gap-2">
      <!-- Desktop-only (design doc §10.1): the content column's other half of
           "collapse both panels for projection". Below xl the content pane
           has no collapse concept (bottom sheet at tablet, inline at phone),
           so there is nothing for this control to do there. -->
      <button
        type="button"
        class="tw:hidden tw:size-11 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-ctl tw:text-text-muted tw:hover:bg-surface-sunken tw:xl:flex"
        :aria-expanded="store.contentOpen"
        aria-controls="case-content-panel"
        aria-label="Toggle content panel"
        @click="store.contentOpen = !store.contentOpen"
      >
        <svg viewBox="0 0 24 24" class="tw:size-5" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
          <line x1="15" y1="5" x2="15" y2="19" stroke="currentColor" stroke-width="2" />
        </svg>
      </button>

      <!--
        Secondary to About by design. The loud, unmissable invitation is the
        first-visit launcher, which expires; this one only has to be
        findable again afterwards, so it stays a quiet outline. The corner-
        bracket glyph previews the tour HUD's own visual language.

        Border is text-muted, not border-strong (1.48:1 on white -- under
        the 3:1 non-text floor; see nav-contrast.test.ts's existing rejection
        of border-strong for the same reason on ModalityStepper/DefaultLayout.vue).
      -->
      <button
        type="button"
        data-tour-open
        class="tw:flex tw:min-h-11 tw:shrink-0 tw:items-center tw:gap-1.5 tw:rounded-full tw:border tw:border-text-muted
               tw:px-2.5 tw:text-body-sm tw:font-semibold tw:text-text-muted tw:hover:bg-surface-sunken tw:hover:text-text tw:md:px-4"
        :aria-label="tour.active ? 'Guided tour is running' : 'Start the guided tour'"
        @click="emit('startTour')"
      >
        <svg viewBox="0 0 16 16" class="tw:size-4 tw:shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M1 4.5V1h3.5" />
          <path d="M11.5 1H15v3.5" />
          <path d="M15 11.5V15h-3.5" />
          <path d="M4.5 15H1v-3.5" />
        </svg>
        <span data-tour-label class="tw:max-md:sr-only">Guided tour</span>
      </button>

      <!--
        A filled control, not a text link -- a touch device never hovers, so
        bare text with only a hover background read as a grey word, not a
        control.

        Soft neutral fill, not the old heavy black: still filled (outranks
        the tour button's outline), still NOT `--color-brand` (rose is this
        app's focus semantic -- the focused panel's ring, the sidebar's
        current row, Locate lesion -- and spending it here would blur what
        "current" means everywhere else).
      -->
      <AppLink
        to="/about"
        class="tw:flex tw:min-h-11 tw:shrink-0 tw:items-center tw:gap-1.5 tw:rounded-full tw:bg-surface-sunken tw:px-4
               tw:text-body-sm tw:font-bold tw:text-text tw:transition-colors tw:hover:bg-border
               tw:max-md:px-3 tw:max-[360px]:gap-0"
      >
        <!-- The glyph, not the label, is what goes below 360px: the label is
             what makes this a control anyone can name, and at 320px the 22px
             the icon costs is exactly what the wordmark needs to stop
             breaking onto a third line. -->
        <svg viewBox="0 0 24 24" class="tw:size-4 tw:shrink-0 tw:max-[360px]:hidden" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path fill="currentColor" d="M11 10.5h2V17h-2zM11 7h2v2h-2z" />
        </svg>
        <span data-about-label>About</span>
      </AppLink>
    </div>
  </header>
</template>
