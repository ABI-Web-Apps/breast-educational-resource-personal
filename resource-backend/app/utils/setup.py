"""Backend configuration: which sample types are read, and where MinIO is."""

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


class Config:
    METADATA_PATH = "manifest.xlsx"
    SAMPLES_METADATA_PATH = "samples.xlsx"
    SUBJECTS_METADATA_PATH = "subjects.xlsx"

    # Resolved by NAME from each dataset's samples.xlsx "Sample Type" column, so
    # the list has no index semantics.
    INPUTS = [
        "contrast_1_nrrd",
        "researcher_manual_LPS_nii",
        "findings_json",
    ]
    # Nothing is ever written back to MinIO.
    OUTPUTS: list[str] = []

    # MinIO SDK credentials. Local default: minioadmin/minioadmin @ localhost:9000.
    # Docker: injected through compose environment.
    MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
    MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
    MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
    MINIO_SECURE = os.environ.get("MINIO_SECURE", "false").lower() in ("true", "1")

    # Derived artefacts (meshes, report assets); never decompressed patient images.
    CACHE_DIR = Path(os.environ.get("DERIVED_CACHE_DIR", BACKEND_ROOT / "cache"))
