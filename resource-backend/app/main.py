"""Backend for the Breast Educational Resource.

The app's imaging catalogue -- NRRD volumes, Draco-compressed GLB anatomy
models and copper3d view presets, ~350MB in all -- is served from here rather
than shipped inside the frontend build. In plugin mode the frontend bundle is
uploaded to the portal's public `tools` bucket on every build; the catalogue
does not belong there, and it does not change when the UI does.

Routes (all under /api, so the same paths work behind the standalone nginx
and behind the portal's /plugin/<expose>/ location, which strips its prefix):

    GET /api/health                 liveness, for compose and the portal
    GET /api/modelView/<path>       the catalogue, read-only
    POST /api/tool-config           validate a tool config, resolve its dataset (SSE)
    GET /api/patients/<assay>/<cohort>/mri       contrast-1 volume, gzip-encoded NRRD
    GET /api/patients/<assay>/<cohort>/findings  the findings record
"""

import mimetypes
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from app.router.patients import router as patients_router
from app.router.tool_config import router as tool_config_router

BACKEND_ROOT = Path(__file__).resolve().parent.parent

MODEL_VIEW_DIR = Path(os.environ.get("MODEL_VIEW_DIR", BACKEND_ROOT / "static" / "modelView"))

# GitHub Pages, which served this catalogue before, sent max-age=600 with an
# ETag. Kept: a re-optimised asset reaches readers within ten minutes, and
# revalidation is a 304 rather than a re-download.
ASSET_CACHE_CONTROL = os.environ.get("ASSET_CACHE_CONTROL", "public, max-age=600")

# Browsers on the Vite dev server (another origin) fetch the catalogue
# directly; every other deployment reaches this backend through nginx on the
# page's own origin and needs no CORS at all.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CORS_ORIGINS", "http://localhost:3158,http://127.0.0.1:3158"
    ).split(",")
    if origin.strip()
]

# Python's mimetypes table knows neither format. Without these, NRRD goes out
# as text/plain, which a proxy configured to gzip text/* would compress again
# -- and a compressed response no longer reports a usable Content-Length, so
# the frontend's load progress (and the stall detection built on it) breaks.
mimetypes.add_type("application/octet-stream", ".nrrd")
mimetypes.add_type("model/gltf-binary", ".glb")


class CatalogueFiles(StaticFiles):
    """Static files with the catalogue's caching policy on every hit."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = ASSET_CACHE_CONTROL
        return response


app = FastAPI(title="Breast Educational Resource", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "ETag"],
)


app.include_router(tool_config_router)
app.include_router(patients_router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "catalogue": MODEL_VIEW_DIR.is_dir()}


app.mount("/api/modelView", CatalogueFiles(directory=MODEL_VIEW_DIR, check_dir=False), name="modelView")
