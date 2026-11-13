"""MinIOService: routing, resolution through the SPARC sheets, and object reads."""

import pytest

from app.models.api_models import DatasetSpec, ToolConfigRequest
from app.services.minio_service import (
    MinIOService,
    MinIOValidationError,
    build_sample_type_routes,
)
from app.utils.setup import Config

BASE = "http://x:9000/measurements/"
KNOWN = list(Config.INPUTS)


def _spec(name, *types):
    return DatasetSpec(name=name, sample_type=list(types))


def _routes():
    return build_sample_type_routes([_spec("workdir", *Config.INPUTS)], Config.INPUTS)


@pytest.fixture(autouse=True)
def _isolate_shared_client():
    original = MinIOService._shared_client
    yield
    MinIOService._shared_client = original


# --- shared client ---------------------------------------------------------------

def test_two_services_share_one_client():
    assert MinIOService().client is MinIOService().client


def test_client_is_reused_across_many_instances():
    clients = [MinIOService().client for _ in range(14)]
    assert len({id(c) for c in clients}) == 1


def test_injected_client_is_used():
    fake = object()
    assert MinIOService(client=fake).client is fake
    assert MinIOService._shared_client is not fake


# --- read_object_bytes ------------------------------------------------------------

class _Obj:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return self._payload

    def close(self):
        pass

    def release_conn(self):
        pass


class _Client:
    def __init__(self, payload=None, boom=False):
        self._payload, self._boom = payload, boom

    def get_object(self, bucket, path):
        if self._boom:
            raise RuntimeError("no such key")
        return _Obj(self._payload)


def test_read_bytes_returns_body():
    assert MinIOService(_Client(b"abc")).read_object_bytes("http://m:9000/b/o") == b"abc"


def test_read_bytes_empty_is_none():
    assert MinIOService(_Client(b"")).read_object_bytes("http://m:9000/b/o") is None


def test_read_bytes_missing_is_none_without_raising():
    assert MinIOService(_Client(boom=True)).read_object_bytes("http://m:9000/b/o") is None


def test_read_bytes_blank_url_is_none():
    assert MinIOService(_Client(b"x")).read_object_bytes("") is None


# --- base url -----------------------------------------------------------------------

def test_validate_base_url_rejects_non_http():
    with pytest.raises(MinIOValidationError) as exc:
        MinIOService(_Client()).validate_base_url("minio:9000/measurements/")
    assert exc.value.step == "1.1"
    MinIOService(_Client()).validate_base_url(BASE)


# --- routes ---------------------------------------------------------------------------

def test_routes_map_each_declared_type_to_its_dataset():
    routes = build_sample_type_routes(
        [_spec("a", "registration_1_nrrd"), _spec("b", "findings_json")], KNOWN
    )
    assert routes == {"registration_1_nrrd": "a", "findings_json": "b"}


def test_routes_reject_unknown_sample_type():
    with pytest.raises(MinIOValidationError) as exc:
        build_sample_type_routes([_spec("workdir", "contrast_one_nrrd")], KNOWN)
    assert exc.value.step == "config"
    assert "contrast_one_nrrd" in exc.value.summary
    assert "registration_1_nrrd" in exc.value.detail


def test_routes_reject_type_claimed_twice():
    with pytest.raises(MinIOValidationError) as exc:
        build_sample_type_routes(
            [_spec("a", "findings_json"), _spec("b", "findings_json")], KNOWN
        )
    assert exc.value.step == "config"
    assert "findings_json" in exc.value.summary
    assert "'a'" in exc.value.summary and "'b'" in exc.value.summary


# --- resolution -------------------------------------------------------------------------

def test_resolves_by_sample_type_not_filename(fake_minio):
    svc = MinIOService(fake_minio)
    r = svc.validate_and_resolve_inputs(
        BASE, [_spec("workdir", *Config.INPUTS)], ["sub-1"], _routes()
    )
    assert r["sub-1"]["registration_1_nrrd"].endswith("/workdir/primary/sub-1/sam-1/c1.nrrd")
    assert r["sub-1"]["researcher_manual_LPS_nii"].endswith("/workdir/primary/sub-1/sam-2/m.nii.gz")
    assert r["sub-1"]["findings_json"].endswith("/workdir/primary/sub-1/sam-3/f.json")
    assert svc.read_object_bytes(r["sub-1"]["findings_json"])


def test_missing_optional_input_is_none(fake_minio):
    r = MinIOService(fake_minio).validate_and_resolve_inputs(
        BASE, [_spec("workdir", *Config.INPUTS)], ["sub-2"], _routes()
    )
    assert r["sub-2"]["findings_json"] is None
    assert r["sub-2"]["registration_1_nrrd"] is not None


def test_unrouted_input_is_none(fake_minio):
    routes = build_sample_type_routes([_spec("workdir", "registration_1_nrrd")], Config.INPUTS)
    r = MinIOService(fake_minio).validate_and_resolve_inputs(
        BASE, [_spec("workdir", "registration_1_nrrd")], ["sub-1"], routes
    )
    assert r["sub-1"]["findings_json"] is None


def test_missing_dataset_metadata_is_a_structured_error(fake_minio):
    routes = build_sample_type_routes([_spec("nope", *Config.INPUTS)], Config.INPUTS)
    with pytest.raises(MinIOValidationError) as exc:
        MinIOService(fake_minio).validate_and_resolve_inputs(
            BASE, [_spec("nope", *Config.INPUTS)], ["sub-1"], routes
        )
    assert exc.value.step == "minio"
    assert "nope/subjects.xlsx" in exc.value.summary


# --- identity ------------------------------------------------------------------------------

def test_object_identity_changes_when_bytes_change(fake_minio, sparc_dataset):
    svc = MinIOService(fake_minio)
    url = BASE + "workdir/primary/sub-1/sam-3/f.json"
    before = svc.object_identity(url)
    assert before == svc.object_identity(url)
    (sparc_dataset / "primary/sub-1/sam-3/f.json").write_text('{"changed": true, "pad": 1}')
    after = svc.object_identity(url)
    assert after != before
    etag, size = after.split(":")
    assert etag and size.isdigit()


# --- request model ---------------------------------------------------------------------------

def test_tool_config_request_ignores_unknown_keys():
    req = ToolConfigRequest.model_validate({
        "user_info": {"uuid": "u", "extra": 1},
        "assay_info": {
            "uuid": "a", "name": "n", "cohorts": ["sub-1 "], "extra": 2,
            "datasets": [{"name": "workdir", "sample_type": ["findings_json"]}],
        },
        "system": {"minio": {"base_url": BASE}},
        "other": 3,
    })
    assert req.assay_info.cohorts == ["sub-1"]
    assert req.system.minio.base_url == BASE
