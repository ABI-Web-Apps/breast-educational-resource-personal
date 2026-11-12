/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** True in the UMD bundle the portal mounts; false in the standalone app. */
declare const __IS_PLUGIN__: boolean
/** App version, injected at build time from package.json's `version`. */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** `/plugin/<expose>`, written into `.env` by the portal's builder. */
  readonly VITE_PLUGIN_ROUTE_PREFIX?: string
  /** Dev only: where the FastAPI backend listens. */
  readonly VITE_PLUGIN_API_URL?: string
  readonly VITE_PLUGIN_API_PORT?: string
  /** Optional imaging base for a deploy with no backend. */
  readonly VITE_ASSET_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
