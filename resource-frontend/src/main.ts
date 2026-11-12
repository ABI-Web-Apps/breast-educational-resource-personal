/**
 * Standalone entry: the app as its own site (`yarn dev`, `yarn build`).
 *
 * The plugin build does not use this file -- its entry is `index.ts`, and the
 * portal supplies the Vue app and the Pinia instance.
 */
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/css/tokens.css'

createApp(App).use(createPinia()).mount('#app')
