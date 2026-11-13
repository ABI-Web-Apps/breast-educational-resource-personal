<script setup lang="ts">
import { MY_MRI_COPY } from '@/content/myMri'

/**
 * One stage column's session state: loading text, or the error summary with a
 * retry button, or (when ready) whatever the column puts in the default slot.
 * Only the column with `live` announces the state, so a screen reader hears
 * it once.
 */
defineProps<{
  status: 'loading' | 'ready' | 'error'
  summary?: string
  progressText: string
  live?: boolean
}>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="tw:min-h-0 tw:flex-1">
    <div
      v-if="status === 'loading'"
      data-state="loading"
      :role="live ? 'status' : undefined"
      class="tw:p-4 tw:text-body-sm tw:text-text-muted"
    >
      {{ progressText }}
    </div>
    <div
      v-else-if="status === 'error'"
      data-state="error"
      :role="live ? 'alert' : undefined"
      class="tw:flex tw:flex-col tw:items-start tw:gap-3 tw:p-4 tw:text-body-sm tw:text-text"
    >
      <p>{{ summary }}</p>
      <button type="button" class="tw:rounded-card tw:border tw:border-border tw:px-3 tw:py-1 tw:font-bold tw:text-text" @click="$emit('retry')">
        {{ MY_MRI_COPY.tryAgain }}
      </button>
    </div>
    <slot v-else />
  </div>
</template>
