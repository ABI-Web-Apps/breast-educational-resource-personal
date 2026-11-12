"""The mask GLB: one coloured mesh per label, vertices in patient LPS millimetres."""

import io
import os
import threading

import nibabel as nib
import numpy as np
import pytest
import trimesh

from app.services import mesh
from app.services.derived_cache import DerivedCache
from tests.conftest import GRID, ORIGIN_LPS, SPACING

URL = "/api/patients/assay-001/{}/mask.glb"


def _nii_bytes(mask: np.ndarray, spacing=SPACING) -> bytes:
    affine = np.diag([-spacing[0], -spacing[1], spacing[2], 1.0])
    affine[:3, 3] = (-ORIGIN_LPS[0], -ORIGIN_LPS[1], ORIGIN_LPS[2])
    return nib.Nifti1Image.to_bytes(nib.Nifti1Image(mask, affine))


def _three_labels() -> bytes:
    mask = np.zeros((24, 8, 8), dtype=np.uint8)
    mask[1:5, 2:6, 2:6] = 1
    mask[9:13, 2:6, 2:6] = 10
    mask[17:21, 2:6, 2:6] = 11
    return _nii_bytes(mask)


def _colours_by_node(glb: bytes) -> dict:
    scene = trimesh.load(io.BytesIO(glb), file_type="glb", force="scene")
    out = {}
    for node in scene.graph.nodes_geometry:
        _, name = scene.graph[node]
        material = scene.geometry[name].visual.material
        out[node] = [round(c * 255) if c <= 1 else c for c in list(material.baseColorFactor)[:3]]
    return out


def test_glb_has_one_node_per_label(loaded_client, cache_dir):
    response = loaded_client.get(URL.format("sub-1"))
    assert response.status_code == 200
    assert response.headers["content-type"] == "model/gltf-binary"
    scene = trimesh.load(io.BytesIO(response.content), file_type="glb")
    assert sorted(scene.graph.nodes_geometry) == ["channel_1", "channel_2"]


def test_glb_takes_colours_from_findings(loaded_client, cache_dir):
    colours = _colours_by_node(loaded_client.get(URL.format("sub-1")).content)
    assert colours == {"channel_1": [255, 112, 67], "channel_2": [66, 165, 245]}


def test_glb_without_findings_uses_neutral_colour(loaded_client, cache_dir):
    colours = _colours_by_node(loaded_client.get(URL.format("sub-2")).content)
    assert colours == {"channel_1": [148, 163, 184], "channel_2": [148, 163, 184]}


def test_glb_vertices_inside_volume_lps_bounds(loaded_client, cache_dir):
    scene = trimesh.load(io.BytesIO(loaded_client.get(URL.format("sub-1")).content), file_type="glb")
    origin = np.array(ORIGIN_LPS)
    far = origin + (np.array(GRID) - 1) * np.array(SPACING)
    vertices = np.vstack([g.vertices for g in scene.geometry.values()])
    assert (vertices >= origin - 1e-3).all()
    assert (vertices <= far + 1e-3).all()
    # Label 1 fills voxels 2..4 / 2..4 / 1..2, so its surface is centred on that block.
    block = scene.geometry[scene.graph["channel_1"][1]].vertices
    centre_index = np.array([3.0, 3.0, 1.5])
    expected = origin + centre_index @ np.diag(SPACING)  # LPS directions are diag(spacing)
    assert np.allclose((block.min(axis=0) + block.max(axis=0)) / 2, expected, atol=1e-3)


def test_glb_is_cached(loaded_client, cache_dir, monkeypatch):
    calls = []
    real = mesh.mask_to_glb

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(mesh, "mask_to_glb", counting)
    first = loaded_client.get(URL.format("sub-1"))
    second = loaded_client.get(URL.format("sub-1"))
    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert len(calls) == 1
    assert len(list(cache_dir.iterdir())) == 1


def test_glb_unknown_label_neutral_colour():
    glb = mesh.mask_to_glb(_three_labels(), {1: "#ff7043"})
    colours = _colours_by_node(glb)
    assert colours["channel_1"] == [255, 112, 67]
    assert colours["channel_10"] == [148, 163, 184]


def test_each_mesh_is_named_by_its_label():
    glb = mesh.mask_to_glb(_three_labels(), {})
    assert sorted(_colours_by_node(glb)) == ["channel_1", "channel_10", "channel_11"]


def test_labels_take_the_colours_sent():
    glb = mesh.mask_to_glb(_three_labels(), {10: "#0c2238", 11: "#c86432"})
    colours = _colours_by_node(glb)
    assert colours["channel_10"] == [12, 34, 56]
    assert colours["channel_11"] == [200, 100, 50]
    assert colours["channel_1"] == [148, 163, 184]


def test_material_is_non_metallic_and_rough():
    scene = trimesh.load(io.BytesIO(mesh.mask_to_glb(_three_labels(), {})), file_type="glb", force="scene")
    material = next(iter(scene.geometry.values())).visual.material
    assert material.metallicFactor == 0
    assert material.roughnessFactor == pytest.approx(0.4)


def test_empty_mask_returns_none():
    assert mesh.mask_to_glb(_nii_bytes(np.zeros(GRID, dtype=np.uint8)), {}) is None


def test_unreadable_mask_raises():
    with pytest.raises(mesh.MaskUnreadable):
        mesh.mask_to_glb(b"not a nifti", {})


def test_glb_empty_mask_404(loaded_client_with_empty_mask):
    response = loaded_client_with_empty_mask.get(URL.format("sub-1"))
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "no_mask"


def test_glb_absent_mask_404(loaded_client, cache_dir, sparc_dataset):
    (sparc_dataset / "primary" / "sub-2" / "sam-2" / "m.nii.gz").unlink()
    response = loaded_client.get(URL.format("sub-2"))
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "no_mask"


def test_glb_unreadable_mask_422(loaded_client, cache_dir, sparc_dataset):
    (sparc_dataset / "primary" / "sub-2" / "sam-2" / "m.nii.gz").write_bytes(b"garbage")
    response = loaded_client.get(URL.format("sub-2"))
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_mask"


def test_derived_cache_builds_once_and_hashes_key(tmp_path):
    cache = DerivedCache(tmp_path / "c")
    calls = []

    def build():
        calls.append(1)
        return b"payload"

    first = cache.get_or_build("some:key", ".glb", build)
    second = cache.get_or_build("some:key", ".glb", build)
    assert first == second and first.read_bytes() == b"payload"
    assert first.suffix == ".glb" and "some" not in first.name
    assert len(calls) == 1
    assert [p.name for p in first.parent.iterdir()] == [first.name]


def test_derived_cache_concurrent_builds_leave_no_partial_file(tmp_path):
    cache = DerivedCache(tmp_path)
    results = []

    def run():
        results.append(cache.get_or_build("k", ".bin", lambda: b"x" * 100000))

    threads = [threading.Thread(target=run) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(results) == 6
    # Read after the join: on Windows a read that overlaps another thread's replace is refused.
    assert all(r.read_bytes() == b"x" * 100000 for r in results)
    assert len(list(tmp_path.iterdir())) == 1


@pytest.mark.parametrize("bad", [None, "#fff", "red", ""])
def test_missing_or_invalid_colour_is_neutral(bad):
    colours = _colours_by_node(mesh.mask_to_glb(_three_labels(), {1: bad, 10: "#0c2238"}))
    assert colours["channel_1"] == [148, 163, 184]
    assert colours["channel_10"] == [12, 34, 56]


def test_glb_finding_without_colour_is_neutral(loaded_client, cache_dir, sparc_dataset):
    import json

    path = sparc_dataset / "primary" / "sub-1" / "sam-3" / "f.json"
    record = json.loads(path.read_text())
    record["findings"][0]["lesion"]["color"] = None
    record["findings"][1]["lesion"]["color"] = "red"
    path.write_text(json.dumps(record))
    response = loaded_client.get(URL.format("sub-1"))
    assert response.status_code == 200
    assert _colours_by_node(response.content) == {
        "channel_1": [148, 163, 184],
        "channel_2": [148, 163, 184],
    }


def test_derived_cache_replace_refused_but_file_present_is_success(tmp_path, monkeypatch):
    cache = DerivedCache(tmp_path)
    real = os.replace

    def refuse(src, dst):
        real(src, dst)  # another request already put the final file in place
        raise PermissionError("in use")

    monkeypatch.setattr(os, "replace", refuse)
    path = cache.get_or_build("k", ".bin", lambda: b"abc")
    assert path.read_bytes() == b"abc"
    assert [p.name for p in tmp_path.iterdir()] == [path.name]


def test_derived_cache_replace_refused_and_file_absent_raises(tmp_path, monkeypatch):
    def refuse(src, dst):
        raise PermissionError("denied")

    monkeypatch.setattr(os, "replace", refuse)
    with pytest.raises(PermissionError):
        DerivedCache(tmp_path).get_or_build("k", ".bin", lambda: b"abc")
    assert list(tmp_path.iterdir()) == []


def test_derived_cache_removes_temp_file_when_build_fails(tmp_path):
    def boom():
        raise RuntimeError("build failed")

    with pytest.raises(RuntimeError):
        DerivedCache(tmp_path).get_or_build("k", ".bin", boom)
    assert list(tmp_path.iterdir()) == []
