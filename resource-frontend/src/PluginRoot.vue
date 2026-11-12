<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import App from './App.vue'

/**
 * The plugin's root element, and the one thing the standalone app does not
 * need: a box that stands in for `<html>`/`<body>`.
 *
 * Every rule in the plugin stylesheet is scoped under `.ber-root` at build
 * time (build/postcss-scope.ts), and the rules the standalone app wrote for
 * `:root`, `html` and `body` land on this element instead. It is also the
 * scroll container, so a page taller than the window (About) scrolls here,
 * with the app's own scrollbar, exactly as the document did standalone.
 *
 * The Inter webfont is the other half of `<head>` the portal does not have.
 * The links are added while the plugin is mounted and removed with it.
 */
const FONT_LINKS: Array<Record<string, string>> = [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700;1,14..32,400&display=swap',
  },
]

const added: HTMLLinkElement[] = []

onMounted(() => {
  for (const attrs of FONT_LINKS) {
    const selector = `link[rel="${attrs.rel}"][href="${attrs.href}"]`
    if (document.head.querySelector(selector)) continue
    const link = document.createElement('link')
    for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value)
    document.head.appendChild(link)
    added.push(link)
  }
})

onBeforeUnmount(() => {
  for (const link of added) link.remove()
  added.length = 0
})
</script>

<template>
  <div class="ber-root">
    <App />
  </div>
</template>
