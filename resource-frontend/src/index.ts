/**
 * Plugin entry: what the portal mounts.
 *
 * The portal loads the UMD bundle, reads the component off
 * `window[<expose>]`, and mounts it with `createApp(Root)` plus a fresh
 * Pinia. Vue and Pinia come from the portal (externals in vite.config.ts).
 *
 * Nothing here may have a global side effect: the bundle is re-executed on
 * every mount. The stylesheet is injected by the build and scoped to
 * `.ber-root`, so it cannot reach the portal's own markup.
 */
import './assets/css/tokens.css'
import PluginRoot from './PluginRoot.vue'

export default PluginRoot
