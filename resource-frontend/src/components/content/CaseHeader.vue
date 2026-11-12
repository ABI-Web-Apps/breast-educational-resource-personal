<script setup lang="ts">
import { CASE_GROUP_LABEL } from '@/content/cases'
import type { Case } from '@/content/types'
import { GROUP_INK } from '@/utils/groupInk'

const props = defineProps<{ case: Case }>()

// The overline takes the group's colour, matching the sidebar heading the
// reader chose the case from.
</script>

<template>
  <header>
    <p
      class="tw:text-caption tw:font-bold tw:uppercase tw:tracking-wide"
      :class="GROUP_INK[props.case.group]"
    >
      {{ CASE_GROUP_LABEL[props.case.group] }}
    </p>

    <!--
      No BI-RADS badge and no "Reference density background: grade X" line.
      Both are gone at the client's instruction (feedback item 3, "I think we
      can remove BIRADS"). The density series carries the grade in its nav
      title instead -- see content/cases.ts.
    -->
    <h1 class="tw:mt-1 tw:text-h1 tw:font-bold tw:text-text tw:xl:text-display">
      {{ props.case.heading }}
    </h1>
  </header>
</template>
