<script setup lang="ts">
import { computed } from 'vue'
import { useAssetUrl } from '@/composables/useAssetUrl'
import { citations, FEEDBACK_FORM_URL, organisations } from '@/content/team'
import AppLink from '@/navigation/AppLink.vue'
import { useDocumentTitle } from '@/navigation/head'
import type { PageRoute } from '@/navigation/routes'

// Every page receives its route from App.vue; this one does not need it, but
// declaring it keeps it from falling through onto <main> as an attribute.
defineProps<{ route?: PageRoute }>()

/**
 * About.
 *
 * Replaces two things at once: a two-sentence stub in this app, and the
 * legacy app's About page, which was a single 4.9MB bitmap of the whole team
 * panel with no way back to the rest of the site.
 *
 * Structured rather than reproduced -- partners, then the people, then where
 * the imaging and the model came from, all as real text with the DOIs as
 * real links. See content/team.ts for what that bitmap cost.
 */
useDocumentTitle(() => 'About — Breast Educational Resource')

const { publicUrl } = useAssetUrl()
const appVersion = __APP_VERSION__

/**
 * The two-person partner groups share one row; the twelve-person research
 * group gets its own.
 *
 * Stacked, each two-person group left most of a row empty and the section
 * ran on for three screens of mostly whitespace. Side by side they read as
 * what they are -- the two partner organisations -- and the page gets
 * shorter without anything shrinking.
 *
 * The "subtle distinction" between them is a single hairline rule, and only
 * between groups actually sharing a row (`sm:` and up, `first:` excluded).
 * Boxing them or tinting them would have made two small groups look more
 * important than the twelve-person one below.
 */
const SIDE_BY_SIDE_MAX = 3
const compactOrgs = computed(() =>
  organisations.filter(o => o.members.length <= SIDE_BY_SIDE_MAX))
const fullWidthOrgs = computed(() =>
  organisations.filter(o => o.members.length > SIDE_BY_SIDE_MAX))
</script>

<template>
  <!-- A `<main>`, not a `<div>`: this page does not use the case layout (it
       has no stage and no sidebar), so nothing else on it provides the one
       main landmark every page owes. -->
  <main class="tw:mx-auto tw:max-w-5xl tw:px-6 tw:py-10 tw:sm:px-10 tw:sm:py-16">
    <!-- The legacy About page was a dead end: it had no way back to the app
         at all, which is the second half of the human's #13. -->
    <AppLink
      to="/"
      class="tw:group tw:inline-flex tw:min-h-11 tw:items-center tw:gap-1.5 tw:text-caption
             tw:uppercase tw:tracking-[0.14em] tw:text-text-muted tw:hover:text-brand-hover"
    >
      <svg viewBox="0 0 24 24" class="tw:size-3 tw:transition-transform tw:group-hover:-translate-x-0.5" aria-hidden="true">
        <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="m15 5-7 7 7 7" />
      </svg>
      Back to the resource
    </AppLink>

    <h1 class="tw:mt-4 tw:text-h1 tw:font-bold tw:tracking-tight tw:text-text">About</h1>
    <p class="tw:prose-medical tw:mt-4 tw:max-w-2xl tw:text-body tw:text-text-muted">
      Te Uma is an educational resource from the Auckland Bioengineering
      Institute, built with Breast Cancer Foundation NZ and Iwi United Engaged.
    </p>

    <!-- ── Partners ─────────────────────────────────────────────────────── -->
    <section class="tw:mt-14" aria-labelledby="partners-heading">
      <h2 id="partners-heading" class="tw:text-caption tw:uppercase tw:tracking-[0.14em] tw:text-text-muted">
        Partners
      </h2>
      <ul class="tw:mt-5 tw:flex tw:flex-wrap tw:items-center tw:gap-x-12 tw:gap-y-8">
        <li v-for="org in organisations.filter(o => o.logo)" :key="org.name">
          <img
            :src="publicUrl(`logos/${org.logo}`)"
            :alt="org.name"
            :style="{ width: `${org.logoWidth}rem` }"
            class="tw:h-auto tw:max-w-full"
            loading="lazy"
          >
        </li>
      </ul>
    </section>

    <!-- ── Team ─────────────────────────────────────────────────────────── -->
    <section class="tw:mt-14" aria-labelledby="team-heading">
      <h2 id="team-heading" class="tw:text-caption tw:uppercase tw:tracking-[0.14em] tw:text-text-muted">
        Our Team
      </h2>

      <!-- The two partner groups, side by side, divided by a hairline. -->
      <div class="tw:mt-8 tw:flex tw:flex-col tw:gap-8 tw:sm:flex-row tw:sm:gap-10">
        <div
          v-for="org in compactOrgs"
          :key="org.name"
          class="tw:sm:border-l tw:sm:border-border tw:sm:pl-10 tw:sm:first:border-l-0 tw:sm:first:pl-0"
        >
          <h3 class="tw:text-body tw:font-bold tw:text-text">{{ org.name }}</h3>
          <!-- Sized off the member count so a pair of portraits stays the
               same size here as in the twelve-person grid below, instead of
               stretching to fill half the page. -->
          <ul
            class="tw:mt-4 tw:grid tw:gap-x-6 tw:gap-y-6"
            :style="{ gridTemplateColumns: `repeat(${org.members.length}, minmax(0, 7.5rem))` }"
          >
          <li v-for="person in org.members" :key="person.name" class="tw:text-center">
            <!--
              `object-contain` in a fixed 3:4 frame, NOT `object-cover` in a
              circle. The circle version clipped every portrait's edges and
              took the top of several heads with them. Nothing is cropped
              here: the frame letterboxes against the page's own sunken
              surface, so tiles stay a uniform size while each face stays
              whole.

              Decorative: the person's name is the very next node in the
              accessibility tree, so an `alt` repeating it would announce
              everyone twice.
            -->
            <img
              :src="publicUrl(`team/${person.photo}`)"
              alt=""
              aria-hidden="true"
              width="240"
              height="320"
              loading="lazy"
              class="tw:aspect-3/4 tw:w-full tw:rounded-card tw:bg-surface-sunken tw:object-contain tw:ring-1 tw:ring-border"
            >
            <span class="tw:mt-2 tw:block tw:text-body-sm tw:leading-snug tw:text-text">{{ person.name }}</span>
          </li>
          </ul>
        </div>
      </div>

      <div v-for="org in fullWidthOrgs" :key="org.name" class="tw:mt-10">
        <h3 class="tw:text-body tw:font-bold tw:text-text">{{ org.name }}</h3>
        <ul class="tw:mt-4 tw:grid tw:grid-cols-3 tw:gap-x-6 tw:gap-y-6 tw:sm:grid-cols-4 tw:md:grid-cols-6">
          <li v-for="person in org.members" :key="person.name" class="tw:text-center">
            <!--
              `object-contain` in a fixed 3:4 frame, NOT `object-cover` in a
              circle. The circle version clipped every portrait's edges and
              took the top of several heads with them. Nothing is cropped
              here: the frame letterboxes against the page's own sunken
              surface, so tiles stay a uniform size while each face stays
              whole.

              Decorative: the person's name is the very next node in the
              accessibility tree, so an `alt` repeating it would announce
              everyone twice.
            -->
            <img
              :src="publicUrl(`team/${person.photo}`)"
              alt=""
              aria-hidden="true"
              width="240"
              height="320"
              loading="lazy"
              class="tw:aspect-3/4 tw:w-full tw:rounded-card tw:bg-surface-sunken tw:object-contain tw:ring-1 tw:ring-border"
            >
            <span class="tw:mt-2 tw:block tw:text-body-sm tw:leading-snug tw:text-text">{{ person.name }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- ── Sources ──────────────────────────────────────────────────────── -->
    <section class="tw:mt-14" aria-labelledby="sources-heading">
      <h2 id="sources-heading" class="tw:text-caption tw:uppercase tw:tracking-[0.14em] tw:text-text-muted">
        Imaging and model sources
      </h2>
      <ul class="tw:mt-5 tw:flex tw:flex-col tw:gap-5">
        <li v-for="c in citations" :key="c.doi" class="tw:max-w-3xl">
          <p class="tw:text-body-sm tw:font-bold tw:text-text">{{ c.used }}</p>
          <p class="tw:mt-1 tw:text-body-sm tw:leading-relaxed tw:text-text-muted">
            {{ c.reference }}
            <!-- A real anchor. In the bitmap this was a picture of a URL. -->
            <a
              :href="c.doi"
              target="_blank"
              rel="noopener noreferrer"
              class="tw:text-brand-hover tw:underline tw:decoration-brand/40 tw:underline-offset-2 tw:hover:decoration-brand"
            >{{ c.doi }}</a>
          </p>
        </li>
      </ul>
    </section>

    <!-- ── Feedback ─────────────────────────────────────────────────────── -->
    <section class="tw:mt-14 tw:border-t tw:border-border tw:pt-8">
      <p class="tw:text-body-sm tw:text-text-muted">
        Visit our
        <a
          :href="FEEDBACK_FORM_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="tw:font-bold tw:text-brand-hover tw:underline tw:decoration-brand/40 tw:underline-offset-2 tw:hover:decoration-brand"
        >online form</a>
        to give us your valuable feedback about this app.
      </p>
      <p class="tw:mt-4 tw:text-caption tw:tabular-nums tw:text-text-muted" data-app-version>
        Breast Educational Resource v{{ appVersion }}
      </p>
    </section>
  </main>
</template>
