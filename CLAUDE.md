# Breast Educational Resource

A portal plugin (Vue 3 + Vite + Tailwind CSS 4 + Pinia frontend, FastAPI
backend) that also runs as a standalone site. See `README.md` for commands and
`../CLAUDE.md` for the portal's build/deploy pipeline.

## Rules that must hold

- **No vue-router.** The portal owns the address bar. Pages come from
  `src/navigation/routes.ts`; navigate with `useAppRouter().navigateTo()`,
  link with `<AppLink>`. Inside a page's subtree read the route with
  `usePageRoute()` -- pages are kept alive, and a hidden page must keep the
  route it was rendered for.
- **Every Tailwind class is written `tw:<utility>`** (`tw:flex`,
  `tw:md:max-xl:fixed`). Unprefixed, the portal's own `!important` Vuetify
  classes of the same name land on this app. `test/classPrefix.test.ts`
  enforces it for templates; class strings in TS (`GROUP_INK`, `buttonClass`,
  ...) need the prefix too.
- **Theme variables are prefixed as well.** In CSS write `--theme(--color-brand)`;
  in an arbitrary value write `var(--tw-color-brand)`. A bare
  `var(--color-brand)` resolves to nothing.
- **Plugin CSS is rewritten at build time** (`tooling/postcss-scope.ts`):
  scoped under `.ber-root`, layers flattened into ID-weight tiers. Do not add
  an ID selector (the build refuses it) and do not rely on `@layer`.
  `:root`/`html`/`body` rules land on the plugin root element.
- **No module-level side effects** -- the UMD bundle re-executes on every
  mount. Global listeners go in `onMounted` with cleanup; anything written to
  `<body>` or `<head>` must be removed on unmount (see `TourLayer`,
  `PluginRoot`).
- **URLs:** imaging through `useAssetUrl().url()`, public files through
  `useAssetUrl().publicUrl()`, the API through `getApiBaseUrl()`
  (`src/runtime/env.ts`). Never hardcode `/api`, a host or a port. Load NRRD
  volumes only through `loadNrrdVolume()`: copper3d fetches them in a `blob:`
  worker that cannot resolve a relative URL (`test/loadNrrdVolume.test.ts`
  enforces it).
- The imaging catalogue lives in `resource-backend/static/modelView/` and is
  served by the backend; never move it into `resource-frontend/public/` (the
  plugin build uploads `public/` to the portal's tools bucket on every build).
- Backend deployment changes go in **both** compose files: the root
  `docker-compose.yml` (standalone) and `resource-backend/docker-compose.yml`
  (plugin, on the `digitaltwins-platform` network, no published port).

## Checks

```bash
cd resource-frontend && yarn test && yarn type-check && yarn build && yarn build:plugin
cd resource-frontend && yarn test:artefacts   # rebuilds both, then the 3D views on build/ and dist/
cd resource-backend && python -m pytest -q
```

`yarn test:artefacts` is the only check that loads the 3D views from what
ships. Every other browser spec runs on `yarn dev`, which uses absolute
backend URLs and unbundled modules -- the copper3d 4.1 upgrade broke both
builds while all of them passed. It needs the backend on :8082 (and this
repo's MinIO on :9010 for the My MRI check).
