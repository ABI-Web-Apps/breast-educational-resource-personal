<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTourStore } from '@/stores/tour'

/**
 * First-visit invitation.
 *
 * A floating button rather than a modal, deliberately: a welcome card,
 * however polite, is a door in the way. This can be ignored and still be
 * found. Once the reader has started or dismissed it, the header's own
 * permanent button is the only entry point from then on.
 */
const store = useTourStore()
const emit = defineEmits<{ start: [] }>()

const dismissed = ref(false)
// Read synchronously (not in onMounted): the initial render must already
// reflect localStorage rather than flashing the launcher for one frame first.
store.restoreSeen()

const visible = computed(() => !store.hasSeen && !dismissed.value && !store.active)
</script>

<template>
  <!-- Stable root, `display: contents` so it generates no box. Same reason
       as TourLayer's: a component whose root is a `v-if` alternates between
       a comment and an element, and on the deployed build that produced an
       update against a subtree with no DOM node. Costs nothing. -->
  <div class="tw:contents">
  <div
    v-if="visible"
    data-tour-launcher
    class="hud-glass tw:fixed tw:right-4 tw:z-40 tw:flex tw:w-80 tw:max-w-[calc(100vw-2rem)] tw:flex-col tw:gap-2.5
           tw:rounded-card tw:p-3.5
           tw:max-md:bottom-4 tw:md:max-xl:bottom-24 tw:xl:bottom-6"
  >
    <!-- Above the tablet bottom sheet's 80px peek and clear of the phone
         layout's prev/next cards: the app already owns its bottom-right. -->
    <p class="tw:text-caption tw:font-medium tw:whitespace-nowrap tw:text-(--hud-ink)">
      New here? A 90-second guided tour.
    </p>
    <div class="tw:flex tw:items-center tw:justify-end tw:gap-2">
      <button
        type="button"
        data-tour-dismiss
        class="tw:flex tw:min-h-11 tw:shrink-0 tw:items-center tw:whitespace-nowrap tw:rounded-full tw:px-3 tw:text-body-sm
               tw:text-(--hud-dim) tw:hover:bg-white/5"
        @click="dismissed = true; store.markSeen()"
      >
        Not now
      </button>
      <button
        type="button"
        data-tour-take
        class="tw:flex tw:min-h-11 tw:shrink-0 tw:items-center tw:whitespace-nowrap tw:rounded-full tw:bg-(--hud-accent)
               tw:px-4 tw:text-body-sm tw:font-bold tw:text-(--hud-base) tw:hover:opacity-90"
        @click="emit('start')"
      >
        ✦ Take the tour
      </button>
    </div>
  </div>
  </div>
</template>

<style scoped>
/* Same glass FAMILY as TourCard/TourRail (design doc T2), but more opaque:
   --hud-glass's .74 alpha is tuned for sitting over the dimmed tour theatre.
   This launcher floats over the ordinary, undimmed light page instead, so
   that alpha lets enough page colour bleed through to fail --hud-dim's
   contrast (axe caught this: composited over white it measures ~3:1, not
   the 4.5:1 body floor). .94 keeps the frosted-glass read while measuring
   ~5.6-6.3:1 for every HUD ink against any real page background. */
.hud-glass {
  background: rgb(20 18 26 / .94);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid var(--hud-line);
  box-shadow: 0 16px 40px rgb(0 0 0 / .45), inset 0 1px 0 rgb(255 255 255 / .07);
}
</style>
