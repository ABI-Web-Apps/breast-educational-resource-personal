<script setup lang="ts">
import { computed } from 'vue'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { MY_MRI_COPY, colourSentence } from '@/content/myMri'
import type { FindingColour } from '@/content/myMri'
import { useDocumentTitle } from '@/navigation/head'
import { providePageRoute } from '@/navigation/router'
import type { PageRoute } from '@/navigation/routes'
import { getToolConfig } from '@/myMri/config'

const props = defineProps<{ route: PageRoute }>()
providePageRoute(computed(() => props.route))

const cohort = computed(() => getToolConfig().assay_info.cohorts[0] ?? '')

// Filled from the dataset's findings once they are loaded; empty until then.
const findings = computed<FindingColour[]>(() => [])
const sentence = computed(() => colourSentence(findings.value))

useDocumentTitle(() => `${MY_MRI_COPY.title} — Breast Educational Resource`)
</script>

<template>
  <DefaultLayout :square-stage="false">
    <template #heading>
      <div class="tw:p-6 tw:pb-0">
        <p class="tw:text-caption tw:font-bold tw:uppercase tw:tracking-wide tw:text-group-results">
          {{ MY_MRI_COPY.eyebrow }}
        </p>
        <h1 class="tw:text-h1 tw:font-bold tw:text-text">{{ MY_MRI_COPY.title }}</h1>
        <p class="tw:mt-1 tw:text-body-sm tw:text-text-muted">{{ MY_MRI_COPY.subline(cohort) }}</p>
      </div>
    </template>

    <template #stage>
      <div class="tw:grid tw:grid-cols-1 tw:gap-4 tw:p-6 tw:xl:grid-cols-2">
        <section class="tw:flex tw:min-h-80 tw:flex-col tw:rounded-card tw:border tw:border-border tw:bg-surface-sunken">
          <h2 class="tw:border-b tw:border-border tw:px-4 tw:py-2 tw:text-body-sm tw:font-bold tw:text-text">
            {{ MY_MRI_COPY.viewerHeading }}
          </h2>
          <div data-slot="my-mri-viewer" class="tw:flex-1" />
        </section>
        <section class="tw:flex tw:min-h-80 tw:flex-col tw:rounded-card tw:border tw:border-border tw:bg-surface-sunken">
          <h2 class="tw:border-b tw:border-border tw:px-4 tw:py-2 tw:text-body-sm tw:font-bold tw:text-text">
            {{ MY_MRI_COPY.reportHeading }}
          </h2>
          <div data-slot="my-mri-report" class="tw:flex-1" />
        </section>
      </div>
    </template>

    <template #content>
      <div class="tw:flex tw:flex-col tw:gap-4 tw:p-6 tw:text-body tw:text-text">
        <h2 class="tw:text-caption tw:font-bold tw:uppercase tw:tracking-wide tw:text-text-muted">
          {{ MY_MRI_COPY.panelHeading }}
        </h2>
        <p>{{ MY_MRI_COPY.intro }}</p>
        <p>
          {{ MY_MRI_COPY.markedAreas }}
          <template v-if="sentence">{{ ' ' }}{{ MY_MRI_COPY.colourMatch(sentence) }}</template>
        </p>
        <p>
          {{ MY_MRI_COPY.controlsLead }}
          <strong>{{ MY_MRI_COPY.controlsReset }}</strong> {{ MY_MRI_COPY.controlsTail }}
        </p>
        <p>{{ MY_MRI_COPY.reportNote }}</p>
      </div>
    </template>
  </DefaultLayout>
</template>
