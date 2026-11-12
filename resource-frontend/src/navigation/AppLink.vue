<script setup lang="ts">
import { computed } from 'vue'
import { useAppRouter } from './router'

/**
 * An in-app link: a real `<a href>`, so it is a link to assistive technology
 * and to the browser, with the click handled here instead of by a page load.
 * The stand-in for `<NuxtLink>`.
 *
 * Modified clicks (new tab, new window, download) are left to the browser,
 * the same guard vue-router's RouterLink applies -- except in plugin mode,
 * where the href is not a URL the portal can serve, so every primary click
 * stays in the app.
 */
const props = defineProps<{ to: string }>()
const router = useAppRouter()
const href = computed(() => router.href(props.to))

function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return
  if (!__IS_PLUGIN__ && (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)) return
  event.preventDefault()
  void router.navigateTo(props.to)
}
</script>

<template>
  <a :href="href" @click="onClick"><slot /></a>
</template>
