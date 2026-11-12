"""GET /api/patients/{assay}/{cohort}/mri and /findings."""

import gzip
import io

import numpy as np
import nrrd

from app.router import patients
from app.utils.setup import Config
from tests.conftest import GRID


def _voxels(payload: bytes) -> np.ndarray:
    with io.BytesIO(payload) as handle:
        return nrrd.read_data(nrrd.read_header(handle), handle, index_order="F")


def _c1(dataset):
    return dataset / "primary" / "sub-1" / "sam-1" / "c1.nrrd"


def test_mri_is_gzip_nrrd_with_length(loaded_client):
    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.status_code == 200 and int(r.headers["content-length"]) == len(r.content)
    assert r.headers["content-type"] == "application/octet-stream"
    header = r.content.split(b"\n\n", 1)[0].decode()
    assert "encoding: gzip" in header and "space: left-posterior-superior" in header
    assert _voxels(r.content).shape == GRID


def test_mri_never_touches_disk(loaded_client, tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    monkeypatch.setattr(Config, "CACHE_DIR", cache)
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    assert loaded_client.get("/api/patients/assay-001/sub-1/mri").status_code == 200
    assert list(cache.iterdir()) == []
    assert list(cwd.iterdir()) == []


def test_raw_nrrd_is_reencoded_without_changing_voxels(loaded_client, sparc_dataset):
    expected = _voxels(_c1(sparc_dataset).read_bytes())
    raw_path = sparc_dataset / "raw.nrrd"
    nrrd.write(str(raw_path), expected, {"space": "left-posterior-superior", "encoding": "raw"}, index_order="F")
    raw = raw_path.read_bytes()
    assert b"encoding: raw" in raw
    _c1(sparc_dataset).write_bytes(raw)

    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.status_code == 200
    assert b"encoding: gzip" in r.content.split(b"\n\n", 1)[0]
    assert len(r.content) < len(raw)
    assert np.array_equal(_voxels(r.content), expected)


def test_gzip_nrrd_passes_through_unchanged(loaded_client, sparc_dataset):
    stored = _c1(sparc_dataset).read_bytes()
    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.content == stored


def test_mri_is_cached_by_object_identity(loaded_client, fake_minio, monkeypatch):
    reads = []
    original = fake_minio.get_object

    def counting(bucket, key):
        reads.append(key)
        return original(bucket, key)

    monkeypatch.setattr(fake_minio, "get_object", counting)
    first = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    second = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert first.content == second.content
    assert len(reads) == 1


def test_mri_cache_keeps_the_two_most_recent(loaded_client, sparc_dataset):
    keys = []
    for n in range(3):
        _c1(sparc_dataset).write_bytes(_c1(sparc_dataset).read_bytes() + bytes(n))  # new identity each time
        loaded_client.get("/api/patients/assay-001/sub-1/mri")
        keys.append(list(patients._mri_cache))
    assert [len(k) for k in keys] == [1, 2, 2]
    assert keys[0][0] not in keys[2] and keys[1][1] in keys[2]


def test_to_gzip_nrrd_accepts_a_gzipped_container():
    payload = b"NRRD0004\ntype: uchar\ndimension: 1\nsizes: 4\nencoding: raw\n\n" + bytes(4)
    out = patients.to_gzip_nrrd(gzip.compress(payload))
    assert b"encoding: gzip" in out.split(b"\n\n", 1)[0]


def test_mri_with_unsupported_encoding_is_422(loaded_client, sparc_dataset):
    _c1(sparc_dataset).write_bytes(b"NRRD0004\ntype: uchar\ndimension: 1\nsizes: 2\nencoding: ascii\n\n1 2\n")
    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_mri"


def test_unknown_assay_409(client):
    for suffix in ("mri", "findings"):
        r = client.get(f"/api/patients/nope/sub-1/{suffix}")
        assert r.status_code == 409 and r.json()["detail"]["code"] == "assay_not_loaded"


def test_unknown_cohort_404(loaded_client):
    for suffix in ("mri", "findings"):
        r = loaded_client.get(f"/api/patients/assay-001/sub-9/{suffix}")
        assert r.status_code == 404 and r.json()["detail"]["code"] == "unknown_cohort"


def test_findings_round_trips_v2(loaded_client):
    r = loaded_client.get("/api/patients/assay-001/sub-1/findings")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert body["schema_version"] == 2  # a stored record keeps the version it was written with
    assert [f["lesion"]["channel"] for f in body["findings"]] == [1, 2]
    assert [f["lesion"]["color"] for f in body["findings"]] == ["#ff7043", "#42a5f5"]


def test_findings_absent_404(loaded_client):
    r = loaded_client.get("/api/patients/assay-001/sub-2/findings")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "no_findings"


def test_findings_that_break_the_schema_are_422(loaded_client, sparc_dataset):
    (sparc_dataset / "primary" / "sub-1" / "sam-3" / "f.json").write_text('{"findings": "nope"}')
    r = loaded_client.get("/api/patients/assay-001/sub-1/findings")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_findings"


def test_mri_removed_after_loading_is_404(loaded_client, sparc_dataset):
    _c1(sparc_dataset).unlink()
    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "no_mri"


def test_truncated_gzip_container_is_422(loaded_client, sparc_dataset):
    payload = b"NRRD0004\ntype: uchar\ndimension: 1\nsizes: 4000\nencoding: raw\n\n" + bytes(range(256)) * 16
    _c1(sparc_dataset).write_bytes(gzip.compress(payload)[:-40])
    r = loaded_client.get("/api/patients/assay-001/sub-1/mri")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_mri"
