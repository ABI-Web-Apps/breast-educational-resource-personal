# Breast Educational Resource (Te Uma)

An interactive breast education resource from the Auckland Bioengineering
Institute: anatomy, mammogram and MRI side by side for the four density
grades, benign findings and cancers, with a guided tour.

It runs three ways from one source tree:

| Mode | What runs | Entry |
|---|---|---|
| **Plugin** | The clinical dashboard portal mounts the UMD bundle and deploys the backend | `yarn build:plugin`, `config.portal.json` |
| **Standalone** | nginx + the Vue app + the FastAPI backend, via Docker | `docker compose up --build` |
| **GitHub Pages** | The static app with the imaging catalogue copied beside it | `.github/workflows/deploy_on_github_pages.yml` |

```
breast-educational-resource/
├── resource-frontend/   Vue 3 + Vite + Tailwind CSS 4 + Pinia (no vue-router)
├── resource-backend/    FastAPI: serves the imaging catalogue under /api
├── config.portal.json   Portal registration metadata
├── docker-compose.yml   Standalone stack
├── scripts/             Asset pipeline (imaging, PWA icons)
├── assets-src/          Uncompressed source imaging (not committed)
└── plan/reference/      PRD, design system, UX review (not committed)
```

## Development

```bash
# Backend: the imaging catalogue on :8082
cd resource-backend
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # bin/ on macOS/Linux
.venv/Scripts/python -m uvicorn app.main:app --port 8082
.venv/Scripts/python -m pytest -q

# Frontend: http://localhost:3158
cd resource-frontend
yarn install
yarn dev
yarn test            # Vitest
yarn type-check      # vue-tsc over src/ and tooling/
yarn test:browser    # Playwright; starts both servers itself
yarn build           # standalone site  -> build/
yarn build:plugin    # portal UMD bundle -> dist/my-app.umd.js
yarn test:artefacts  # rebuilds both, then checks the 3D views paint in each
```

`yarn dev` talks to the backend on `http://localhost:8082` (see
`resource-frontend/.env.example`); the backend allows that origin by default.

## How it fits the portal

- **No vue-router.** The portal owns the address bar. Pages are chosen by a
  small route table (`src/navigation/`): it follows the URL in standalone
  mode and runs in memory as a plugin. Links are `<AppLink>`.
- **Externals.** The plugin build leaves Vue, Pinia, Vuetify and
  vue-toastification to the portal's globals, as the portal's builder requires.
- **CSS isolation.** Every Tailwind utility carries the `tw:` prefix, so the
  portal's Vuetify utility classes of the same names (`text-caption`,
  `bg-surface`, ...) never land on this app's markup. The plugin build also
  scopes every rule under `.ber-root` and flattens Tailwind's cascade layers
  into specificity tiers (`tooling/postcss-scope.ts`), so the portal's
  unlayered resets cannot override the app and the app's CSS cannot reach the
  portal.
- **Assets.** Imaging comes from the backend (`<route prefix>/api/modelView/`);
  logos, portraits and the Draco decoder ship inside the build and resolve
  against the bundle's own URL.

## Assets

Imaging assets are produced by a compression pipeline. Put the uncompressed
sources under `assets-src/modelView/`, then:

```bash
node scripts/optimize-assets.mjs   # -> resource-backend/static/modelView/
```

The pipeline re-encodes NRRD volumes as gzip, compresses GLB geometry with
Draco, and skips the 12 files an md5 audit identified as placeholder copies.
The generated `resource-backend/static/modelView/` **is** committed: the
backend image and the GitHub Pages build both copy it.

The four `density*.glb` anatomy models are derived from `density-3` by adding
and removing whole mammary lobes:

```bash
node scripts/build-density-models.mjs [--dry-run]
```

PWA icons are generated from `resource-frontend/public/icon.png`:

```bash
cd resource-frontend && yarn icons
```

The scripts resolve their tools (`@gltf-transform`, `pngjs`) from
`resource-frontend/node_modules`, so run `yarn install` there first.

## Deployment

### Portal plugin

Register the repository (or upload it as a folder/zip) in the portal. The
builder reads `config.portal.json`, runs `yarn build:plugin` in
`resource-frontend/`, and deploys `resource-backend/docker-compose.yml` onto
the `digitaltwins-platform` network. Nginx then routes
`/plugin/<expose_name>/` to the backend container on port 8082.

### Standalone (Docker)

```bash
docker compose up --build   # http://localhost:3158
```

### GitHub Pages

`.github/workflows/deploy_on_github_pages.yml` builds the standalone app under
`/<repo>/`, copies the imaging catalogue beside it (`VITE_ASSET_BASE`), and
publishes to the `gh-pages` branch. It runs on a new release, or on demand
from the Actions tab.

## Important documentation

- [Vue 3](https://vuejs.org/) and [Vite](https://vite.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/docs)
- [Pinia](https://pinia.vuejs.org/)
- [FastAPI](https://fastapi.tiangolo.com/)
- [Threejs](https://threejs.org/docs/)
- [Copper3d](https://github.com/LinkunGao/copper3d_visualisation)
