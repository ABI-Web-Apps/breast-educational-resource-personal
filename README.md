# Breast Educational Resource (Te Uma)

An interactive breast education resource from the Auckland Bioengineering
Institute: anatomy, mammogram and MRI side by side for the four density
grades, benign findings and cancers, with a guided tour. A **My MRI** page
shows a patient's own scan in 3D, with the marked areas, beside a findings
report (PDF) built from a dataset held in MinIO.

It runs three ways from one source tree:

| Mode | What runs | Entry |
|---|---|---|
| **Plugin** | The clinical dashboard portal mounts the UMD bundle and deploys the backend | `yarn build:plugin`, `config.portal.json` |
| **Standalone** | nginx + the Vue app + the FastAPI backend, via Docker | `docker compose up --build` |
| **GitHub Pages** | The static app with the imaging catalogue copied beside it | `.github/workflows/deploy_on_github_pages.yml` |

```
breast-educational-resource/
├── resource-frontend/   Vue 3 + Vite + Tailwind CSS 4 + Pinia (no vue-router)
├── resource-backend/    FastAPI: the imaging catalogue and the My MRI data/report under /api
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

### My MRI

The My MRI page reads a SPARC dataset from the `measurements` bucket, so it
needs a MinIO with the dataset in it. The education pages do not.

MinIO publishes its API on host port 9000 and its console on 9001. When
something else already holds those ports (for example the validator), set
`MINIO_API_PORT` and `MINIO_CONSOLE_PORT` (say 9010 and 9011) for every
`docker compose` command in this repo. The local backend finds MinIO through
`MINIO_ENDPOINT`: `localhost:9000` by default, or `localhost:<MINIO_API_PORT>`
with the overrides.

These commands are for bash (Git Bash on Windows); a PowerShell version
follows.

```bash
# 1. Start MinIO only (prefix the port overrides if you need them).
docker compose up -d minio minio-init

# 2. Upload the dataset folder as measurements/workdir. MSYS_NO_PATHCONV=1 is
#    for Git Bash: without it the -v path is mangled and the mount silently does
#    not take effect. It does nothing elsewhere. The keys are expanded inside
#    the container, from the compose file's MINIO_ROOT_USER/MINIO_ROOT_PASSWORD.
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -v "./resource-backend/static/workdir:/w:ro" --entrypoint sh minio-init \
  -c 'mc alias set l http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc mirror --overwrite /w l/measurements/workdir'

# 3. Run the backend against it (localhost:9010 with the overrides).
cd resource-backend
MINIO_ENDPOINT=localhost:9000 .venv/Scripts/python -m uvicorn app.main:app --port 8082
```

The same in PowerShell. `$env:` settings last for the rest of the session.
Leave out the first line when 9000/9001 are free, and then use
`$env:MINIO_ENDPOINT='localhost:9000'`.

```powershell
$env:MINIO_API_PORT='9010'; $env:MINIO_CONSOLE_PORT='9011'
docker compose up -d minio minio-init
docker compose run --rm --no-deps -v "./resource-backend/static/workdir:/w:ro" --entrypoint sh minio-init -c 'mc alias set l http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc mirror --overwrite /w l/measurements/workdir'
cd resource-backend
$env:MINIO_ENDPOINT='localhost:9010'; .venv\Scripts\python -m uvicorn app.main:app --port 8082
```

Instead of step 2 you can upload through the MinIO console
(<http://localhost:9001>, or your `MINIO_CONSOLE_PORT`; `minioadmin` /
`minioadmin`): open the `measurements` bucket and upload the contents of
`static/workdir/` into a `workdir/` folder.

Then open <http://localhost:3158/my-mri>. The report is a WeasyPrint PDF, which
needs system libraries (Pango, fonts) that only the Docker image installs: on a
local backend the report column shows "Report rendering needs the Docker
backend." and the PDF tests are skipped. Use the full Docker stack to see the
report.

`resource-frontend/test-browser/my-mri.spec.ts` covers the page end to end. It
runs only with `MY_MRI_E2E=1` and a dataset in place. Its base URL is the Docker
stack on :3159 by default. The standalone stack publishes on :3158 unless told
otherwise, so bring it up with the port the spec expects (plus the MinIO port
overrides, if you use them):

```bash
FRONTEND_PORT=3159 docker compose up --build -d
cd resource-frontend
MY_MRI_E2E=1 yarn playwright test my-mri
```

`playwright.config.ts` always declares `webServer` entries (`yarn dev` on :3158
and uvicorn on :8082, `reuseExistingServer: true`), so running the spec also
starts a local dev server and backend when none is running; against the Docker
stack they are simply unused.

To run it against a local backend instead, the dev server and a backend started
with `MINIO_ENDPOINT` pointing at your MinIO (step 3 above) must already be
running: a uvicorn that Playwright spawns itself does not have that variable.

```bash
MY_MRI_E2E=1 MY_MRI_BASE_URL=http://localhost:3158 MY_MRI_BACKEND=local yarn playwright test my-mri
```

### Data

The dataset (`resource-backend/static/workdir/`, a SPARC dataset with the
registered MRI, the researcher's mask and a findings JSON per patient) is
patient data. It lives in the `measurements` bucket under `workdir/`, and is
**never committed or baked into the image**: `static/workdir/` and
`minio_data/` are gitignored, and the image ships only `static/modelView/`. The
backend finds files by their Sample Type in `samples.xlsx`, never by filename,
reads volumes into memory, and writes nothing back to MinIO.

The page reads which patient, dataset and MinIO to use from
`resource-frontend/src/assets/tool_config.json` through `getToolConfig()` in
`src/myMri/config.ts`. That function is the seam the portal will replace to
supply its own config.

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

Register the GitHub repository in the portal. The builder reads
`config.portal.json`, runs `yarn build:plugin` in `resource-frontend/`, and
deploys `resource-backend/docker-compose.yml` onto the `digitaltwins-platform`
network. Nginx then routes `/plugin/<expose_name>/` to the backend container on
port 8082.

> [!WARNING]
> **Never upload your working folder to the portal.** The portal's folder/zip
> upload copies the whole project, everything except `.git`, `node_modules`,
> `dist` and `build`, into its **public** `tools` bucket. A development
> checkout holds patient data that would then be public:
>
> - `resource-backend/static/workdir/`: the patient dataset
> - `resource-backend/minio_data/`: the local MinIO's storage, the same data again
> - `resource-backend/cache/`: report PDFs and meshes built from it
>
> To register without GitHub, upload a clean export of the committed tree,
> which holds none of them:
> `git archive --format=zip -o breast-educational-resource.zip HEAD`.

The backend reads the dataset from the **portal's** MinIO: the plugin compose
takes its keys from `MINIO_SERVER_ACCESS_KEY` / `MINIO_SERVER_SECRET_KEY`
(default `minioadmin`) and reaches it as `minio:9000` on that network. Upload
the dataset to that MinIO's `measurements` bucket as `workdir/`.

### Standalone (Docker)

```bash
docker compose up --build   # http://localhost:3158
```

The standalone stack includes its own MinIO (`pgsty/minio`), which `minio-init`
gives a `measurements` bucket. Its API and console are published on 9000/9001;
override with `MINIO_API_PORT`, `MINIO_CONSOLE_PORT` and `FRONTEND_PORT` when
those are taken. Upload the dataset as in the My MRI section above.

### GitHub Pages

`.github/workflows/deploy_on_github_pages.yml` builds the standalone app under
`/<repo>/`, copies the imaging catalogue beside it (`VITE_ASSET_BASE`), and
publishes to the `gh-pages` branch. It runs on a new release, or on demand
from the Actions tab. Pages has no backend, so that build leaves My MRI out:
setting `VITE_ASSET_BASE` hides YOUR RESULTS and makes `/my-mri` a 404
(`hasBackend()` in `src/runtime/env.ts`).

## Important documentation

- [Vue 3](https://vuejs.org/) and [Vite](https://vite.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/docs)
- [Pinia](https://pinia.vuejs.org/)
- [FastAPI](https://fastapi.tiangolo.com/)
- [Threejs](https://threejs.org/docs/)
- [Copper3d](https://github.com/LinkunGao/copper3d_visualisation)
