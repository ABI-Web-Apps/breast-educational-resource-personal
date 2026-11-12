"""The backend's whole contract: health, and the catalogue served intact."""

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def catalogue(tmp_path, monkeypatch):
    root = tmp_path / "modelView"
    (root / "density-1" / "right").mkdir(parents=True)
    (root / "density-1" / "right" / "mri.nrrd").write_bytes(b"NRRD0004\n" + bytes(range(256)) * 4)
    (root / "density-1" / "left").mkdir(parents=True)
    (root / "density-1" / "left" / "density25.glb").write_bytes(b"glTF" + b"\0" * 60)
    (root / "left_breast_view.json").write_text('{"cameraPosition":[0,0,1]}')
    monkeypatch.setenv("MODEL_VIEW_DIR", str(root))
    import app.main as main

    importlib.reload(main)
    return TestClient(main.app), root


def test_health_reports_the_catalogue(catalogue):
    client, _ = catalogue
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "catalogue": True}


def test_volume_is_served_byte_for_byte(catalogue):
    client, root = catalogue
    response = client.get("/api/modelView/density-1/right/mri.nrrd")
    assert response.status_code == 200
    assert response.content == (root / "density-1" / "right" / "mri.nrrd").read_bytes()
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(response.content))
    assert response.headers["cache-control"] == "public, max-age=600"


def test_model_and_preset_types(catalogue):
    client, _ = catalogue
    assert client.get("/api/modelView/density-1/left/density25.glb").headers["content-type"] == "model/gltf-binary"
    preset = client.get("/api/modelView/left_breast_view.json")
    assert preset.headers["content-type"].startswith("application/json")
    assert preset.json() == {"cameraPosition": [0, 0, 1]}


def test_revalidation_is_a_304(catalogue):
    client, _ = catalogue
    first = client.get("/api/modelView/left_breast_view.json")
    again = client.get("/api/modelView/left_breast_view.json", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304


def test_missing_asset_is_a_404(catalogue):
    client, _ = catalogue
    assert client.get("/api/modelView/nope/mri.nrrd").status_code == 404


def test_path_traversal_is_refused(catalogue):
    client, _ = catalogue
    assert client.get("/api/modelView/../../app/main.py").status_code == 404
    assert client.get("/api/modelView/%2e%2e/%2e%2e/app/main.py").status_code == 404


def test_dev_server_origin_may_read_the_catalogue(catalogue):
    client, _ = catalogue
    response = client.get("/api/modelView/left_breast_view.json", headers={"Origin": "http://localhost:3158"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3158"


def test_other_origins_get_no_cors_grant(catalogue):
    client, _ = catalogue
    response = client.get("/api/modelView/left_breast_view.json", headers={"Origin": "https://example.org"})
    assert "access-control-allow-origin" not in response.headers
