<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { createAppRouter, provideAppRouter } from '@/navigation/router'
import { casePageKey } from '@/utils/pageKey'
import AboutPage from '@/pages/AboutPage.vue'
import CasePage from '@/pages/CasePage.vue'
import NotFoundPage from '@/pages/NotFoundPage.vue'

/**
 * The app shell: one router, one page on screen, pages kept alive.
 *
 * Standalone, the address bar drives the page. As a plugin, navigation is in
 * memory and starts at `/`, which redirects to the home case -- the same
 * first page a visitor to the site's root gets.
 */
const router = createAppRouter({
  history: !__IS_PLUGIN__,
  base: import.meta.env.BASE_URL,
})
provideAppRouter(router)

onMounted(() => router.start())
onBeforeUnmount(() => router.stop())

const route = router.route

/**
 * Decides when the case page's component instance -- and the WebGL
 * renderers inside it -- is reused rather than rebuilt. The rule lives in
 * `utils/pageKey.ts`, where it is documented and unit-tested: every case
 * shares one key, so stepping between cases keeps every decoded scene.
 *
 * Every other page keys on its path.
 */
const pageKey = computed(() => casePageKey(route.value.params.slug) ?? route.value.path)
const page = computed(() => (route.value.name === 'case' ? CasePage : AboutPage))
</script>

<template>
  <!--
    A 404 replaces the kept-alive tree rather than joining it, the way a Nuxt
    error page replaced the whole app: the cached pages (and their renderers)
    are released, and "Go back home" starts afresh.
  -->
  <NotFoundPage v-if="route.name === 'not-found'" :path="route.path" />
  <KeepAlive v-else>
    <component :is="page" :key="pageKey" :route="route" />
  </KeepAlive>
</template>
