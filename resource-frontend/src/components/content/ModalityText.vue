<script setup lang="ts">
import { computed } from 'vue'
import type { Modality } from '@/content/types'
import { MODALITY_INK } from '@/utils/modalityInk'
import { layOutCopy } from './groupSentences'

const props = defineProps<{ modality: Modality }>()

const copy = computed(() => layOutCopy(props.modality.text))
</script>

<template>
  <div class="tw:prose-medical">
    <!--
      Which panel this column is talking about.

      Not decoration: at three-up there are three canvases on screen and,
      until this line existed, nothing in the content column said which one
      the paragraph belonged to. The label is the app's own interface word
      (the same string the tab strip and the prev/next cards use) in that
      modality's own ink -- no clinical copy is involved.
    -->
    <p
      data-modality-overline
      class="tw:flex tw:items-center tw:gap-2.5 tw:text-caption tw:font-bold tw:uppercase tw:tracking-[0.16em]"
      :class="MODALITY_INK[props.modality.id]"
    >
      <span class="tw:h-px tw:w-6 tw:shrink-0 tw:bg-current tw:opacity-50" aria-hidden="true" />
      {{ props.modality.label }}
    </p>

    <!--
      The first sentence enlarged into a lede. Purely a style change -- the
      characters are untouched, and `layOutCopy` withholds the treatment
      entirely rather than setting a 269-character sentence at 20px.
    -->
    <p
      v-if="copy.lede"
      data-modality-copy
      class="tw:mt-3.5 tw:text-h2 tw:font-normal tw:leading-[1.45] tw:tracking-[-0.012em] tw:text-text"
      v-html="copy.lede"
    />

    <!--
      Body paragraphs in the full ink, NOT text-muted.

      Grey body copy on a near-white page is half of what read on screen as
      haze. The hierarchy here is carried by size and leading -- 20px lede
      over 16px body at 1.75 -- which is how it is carried in print, rather
      than by fading the thing the reader actually came to read.
    -->
    <p
      v-for="(para, i) in copy.body"
      :key="i"
      data-modality-copy
      class="tw:mt-4 tw:text-body tw:leading-[1.75] tw:text-text"
      v-html="para"
    />

    <!-- Reserved by the schema (global constraint): keyFacts is always [],
         so this never renders today. -->
    <ul v-if="props.modality.keyFacts.length" class="tw:mt-5 tw:flex tw:flex-col tw:gap-2">
      <li
        v-for="fact in props.modality.keyFacts"
        :key="fact"
        class="tw:flex tw:gap-2 tw:text-body-sm tw:text-text"
      >
        <span class="tw:mt-2 tw:size-1.5 tw:shrink-0 tw:rounded-full tw:bg-brand" aria-hidden="true" />
        {{ fact }}
      </li>
    </ul>
  </div>
</template>
