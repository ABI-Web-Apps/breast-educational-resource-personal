<script setup lang="ts">
/** The title row of a stage column; one fixed height so neighbouring columns line up. */
defineProps<{ title: string }>()
</script>

<template>
  <div class="tw:flex tw:min-h-12 tw:items-center tw:justify-between tw:border-b tw:border-border tw:px-4 tw:py-2">
    <h2 class="tw:text-body-sm tw:font-bold tw:text-text">{{ title }}</h2>
    <slot />
  </div>
</template>
