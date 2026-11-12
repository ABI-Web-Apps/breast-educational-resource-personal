import { onActivated, onDeactivated, ref, watchEffect } from 'vue'

/** The title every page falls back to: the old `app.head.title`. */
export const APP_TITLE = 'Breast Educational Resource'

/**
 * Sets `document.title` while the calling page is on screen. The stand-in
 * for `useHead({ title })`.
 *
 * Kept-alive aware the way @unhead/vue is: a page hidden by KeepAlive stops
 * contributing, and takes over again when it is shown.
 *
 * A no-op in plugin mode. The document belongs to the portal there, and a
 * plugin rewriting the portal's tab title would outlive the plugin itself.
 */
export function useDocumentTitle(title: () => string) {
  if (__IS_PLUGIN__) return
  const active = ref(true)
  onActivated(() => { active.value = true })
  onDeactivated(() => { active.value = false })
  watchEffect(() => {
    if (active.value) document.title = title()
  })
}
