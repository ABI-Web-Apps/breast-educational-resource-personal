"""Shared test fixtures."""

import copy
import json
from pathlib import Path
from typing import NamedTuple

import nibabel as nib
import numpy as np
import nrrd
import pandas as pd
import pytest

GRID = (12, 10, 6)
SPACING = (0.885, 0.885, 1.5)
ORIGIN_LPS = (-175.5, -159.9, -84.4)

# (subject, sample id, sample type, file name). File names deliberately do not
# match the sample type: the dataset is read through samples.xlsx, not by name.
_SAMPLES = [
    ("sub-1", "sam-1", "contrast_1_nrrd", "c1.nrrd"),
    ("sub-1", "sam-2", "researcher_manual_LPS_nii", "m.nii.gz"),
    ("sub-1", "sam-3", "findings_json", "f.json"),
    ("sub-2", "sam-1", "contrast_1_nrrd", "c1.nrrd"),
    ("sub-2", "sam-2", "researcher_manual_LPS_nii", "m.nii.gz"),
]


def _findings() -> dict:
    def finding(n: int, color: str) -> dict:
        return {
            "id": f"f_{n}",
            "label": f"Finding {n}",
            "lesion": {"layer_id": f"layer{n}", "channel": n, "color": color},
            "kinetics": {
                "early_phase": "medium",
                "delayed_phase": "persistent",
                "curve": {
                    "phases": ["contrast_pre", "contrast_1"],
                    "mean_intensity": [420.6, 782.3],
                    "percent_change": [0.0, 86.0],
                },
                "source": "computed",
            },
            "location": {
                "laterality": None,
                "clock_position": None,
                "quadrant": None,
                "depth": None,
                "distance_nipple_cm": None,
                "distance_skin_cm": None,
                "distance_ribcage_cm": None,
            },
            "size": {
                "max_linear_mm": None,
                "ap_mm": None,
                "transverse_mm": None,
                "craniocaudal_mm": None,
                "volume_mm3": None,
            },
            "assessment": None,
            "provenance": {"mask_edited": False, "mask_edited_at": None},
        }

    return {
        "schema_version": 2,
        "updated_at": "2026-08-10T00:00:00Z",
        "breast_tissue": {"fgt": None, "bpe_level": None, "bpe_symmetry": None},
        "findings": [finding(1, "#ff7043"), finding(2, "#42a5f5")],
        "assessment": {"category": None, "source": "derived"},
    }


def _write_nrrd(path: Path) -> None:
    data = (np.arange(np.prod(GRID), dtype=np.uint16) % 997).reshape(GRID)
    header = {
        "space": "left-posterior-superior",
        "space directions": np.diag(SPACING),
        "space origin": np.array(ORIGIN_LPS),
        "kinds": ["domain", "domain", "domain"],
        "encoding": "gzip",
    }
    nrrd.write(str(path), data, header)


def _write_mask(path: Path) -> None:
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[2:5, 2:5, 1:3] = 1  # label 1: a 3x3x2 block
    mask[8, 6, 4] = 2  # label 2: a single voxel
    # The NRRD is on an LPS grid; NIfTI is RAS, so x and y flip sign.
    affine = np.diag([-SPACING[0], -SPACING[1], SPACING[2], 1.0])
    affine[:3, 3] = (-ORIGIN_LPS[0], -ORIGIN_LPS[1], ORIGIN_LPS[2])
    nib.save(nib.Nifti1Image(mask, affine), str(path))


@pytest.fixture()
def sparc_dataset(tmp_path) -> Path:
    """A tiny SPARC dataset folder (`workdir`): sub-1 with findings, sub-2 without."""
    root = tmp_path / "workdir"
    rows = []
    for subject, sample, sample_type, name in _SAMPLES:
        folder = root / "primary" / subject / sample
        folder.mkdir(parents=True)
        path = folder / name
        if sample_type == "contrast_1_nrrd":
            _write_nrrd(path)
        elif sample_type == "researcher_manual_LPS_nii":
            _write_mask(path)
        else:
            path.write_text(json.dumps(_findings()))
        rows.append((subject, sample, sample_type, f"primary/{subject}/{sample}/{name}"))

    pd.DataFrame({"subject id": ["sub-1", "sub-2"]}).to_excel(root / "subjects.xlsx", index=False)
    pd.DataFrame(
        {
            "sample id": [r[1] for r in rows],
            "subject id": [r[0] for r in rows],
            "sample type": [r[2] for r in rows],
        }
    ).to_excel(root / "samples.xlsx", index=False)
    pd.DataFrame(
        {
            "filename": [r[3] for r in rows],
            "timestamp": "2026-09-03 01:34:10",
            "description": [f"File of subject {r[0]} sample {r[1]}" for r in rows],
            "file type": [Path(r[3]).suffix for r in rows],
        }
    ).to_excel(root / "manifest.xlsx", index=False)
    return root


class _FakeObject:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def close(self) -> None:
        pass

    def release_conn(self) -> None:
        pass


class _FakeStat:
    def __init__(self, path: Path):
        stat = path.stat()
        self.size = stat.st_size
        self.etag = f"{stat.st_mtime_ns:x}{stat.st_size:x}"


class FakeMinio:
    """The slice of the MinIO client the service calls, served from a folder on disk.

    Bucket `measurements`; a key `workdir/primary/...` maps to `<parent of root>/workdir/...`.
    """

    def __init__(self, dataset_root: Path, bucket: str = "measurements"):
        self._base = dataset_root.parent
        self._bucket = bucket

    def _path(self, bucket: str, key: str) -> Path:
        from minio.error import S3Error

        if bucket != self._bucket:
            raise S3Error(None, "NoSuchBucket", "bucket missing", bucket, "req", "host")
        path = self._base / key
        if not path.is_file():
            raise S3Error(None, "NoSuchKey", "key missing", key, "req", "host")
        return path

    def get_object(self, bucket: str, key: str) -> _FakeObject:
        return _FakeObject(self._path(bucket, key).read_bytes())

    def stat_object(self, bucket: str, key: str) -> _FakeStat:
        return _FakeStat(self._path(bucket, key))


@pytest.fixture()
def fake_minio(sparc_dataset) -> FakeMinio:
    return FakeMinio(sparc_dataset)


TOOL_CONFIG = {
    "user_info": {"uuid": "user-001"},
    "assay_info": {
        "uuid": "assay-001",
        "name": "breast-educational-resource",
        "cohorts": ["sub-1"],
        "datasets": [
            {
                "name": "workdir",
                "sample_type": ["contrast_1_nrrd", "researcher_manual_LPS_nii", "findings_json"],
            }
        ],
    },
    "system": {"minio": {"base_url": "http://localhost:9000/measurements/"}},
}


@pytest.fixture()
def tool_config() -> dict:
    """A fresh copy of the frontend's tool_config.json, safe to mutate."""
    return copy.deepcopy(TOOL_CONFIG)


@pytest.fixture()
def client(fake_minio):
    """TestClient with MinIO replaced by the fake and an empty assay registry."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.router.tool_config import get_minio_service
    from app.services.assay_registry import registry
    from app.services.minio_service import MinIOService

    registry.clear()
    app.dependency_overrides[get_minio_service] = lambda: MinIOService(client=fake_minio)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_minio_service, None)
        registry.clear()


@pytest.fixture()
def loaded_client(client, tool_config):
    """`client` after posting the shared tool config for sub-1 and sub-2 and draining the stream."""
    from app.router import patients

    tool_config["assay_info"]["cohorts"] = ["sub-1", "sub-2"]
    patients.clear_mri_cache()
    response = client.post("/api/tool-config", json=tool_config)
    assert response.status_code == 200
    assert "event: complete" in response.text
    yield client
    patients.clear_mri_cache()


@pytest.fixture()
def cache_dir(tmp_path, monkeypatch) -> Path:
    """The derived-file cache redirected to a fresh temp folder."""
    from app.utils.setup import Config

    folder = tmp_path / "derived-cache"
    monkeypatch.setattr(Config, "CACHE_DIR", folder)
    return folder


@pytest.fixture()
def loaded_client_with_empty_mask(sparc_dataset, client, tool_config, cache_dir):
    """`loaded_client` after sub-1's mask is overwritten with an all-zero mask on the same grid."""
    from app.router import patients

    path = sparc_dataset / "primary" / "sub-1" / "sam-2" / "m.nii.gz"
    affine = np.diag([-SPACING[0], -SPACING[1], SPACING[2], 1.0])
    affine[:3, 3] = (-ORIGIN_LPS[0], -ORIGIN_LPS[1], ORIGIN_LPS[2])
    nib.save(nib.Nifti1Image(np.zeros(GRID, dtype=np.uint8), affine), str(path))

    tool_config["assay_info"]["cohorts"] = ["sub-1", "sub-2"]
    patients.clear_mri_cache()
    assert client.post("/api/tool-config", json=tool_config).status_code == 200
    yield client
    patients.clear_mri_cache()


class ReportInputs(NamedTuple):
    """What the report builders take after the cohort: findings, volume bytes, mask bytes."""

    findings: object
    volume: bytes
    mask: bytes


@pytest.fixture()
def loaded_service(fake_minio) -> ReportInputs:
    """sub-1's parsed findings plus its contrast-1 volume and mask bytes, read through
    `fake_minio` the way the report route reads them. Unpacks straight into
    `build_report_html("sub-1", *loaded_service, zone)`."""
    from app.reports import schema
    from app.services.minio_service import MinIOService

    service = MinIOService(client=fake_minio)
    base = "http://localhost:9000/measurements/workdir/primary/sub-1"
    return ReportInputs(
        findings=schema.loads(service.read_object_bytes(f"{base}/sam-3/f.json")),
        volume=service.read_object_bytes(f"{base}/sam-1/c1.nrrd"),
        mask=service.read_object_bytes(f"{base}/sam-2/m.nii.gz"),
    )
