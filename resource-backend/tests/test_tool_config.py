"""POST /api/tool-config: pre-stream validation, SSE progress, in-memory registry."""

import json

from app.services.assay_registry import ResolvedAssay, registry


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_tool_config_streams_resolved_then_complete(client, tool_config):
    response = client.post("/api/tool-config", json=tool_config)
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(response.text)
    assert [e for e, _ in events] == ["progress", "resolved", "complete"]
    assert events[0][1] == {"step": "resolve", "case": "sub-1", "current": 1, "total_cases": 1}
    resolved = [d for e, d in events if e == "resolved"]
    assert resolved[0] == {
        "case": "sub-1",
        "inputs": {"contrast_1_nrrd": True, "researcher_manual_LPS_nii": True, "findings_json": True},
    }
    assert events[-1][1] == {"assay": "assay-001", "cases": ["sub-1"]}
    assert registry.get("assay-001").cohorts["sub-1"]["contrast_1_nrrd"]


def test_tool_config_repost_replaces_registry_entry(client, tool_config):
    client.post("/api/tool-config", json=tool_config)
    tool_config["assay_info"]["cohorts"] = ["sub-1", "sub-2"]
    events = parse_sse(client.post("/api/tool-config", json=tool_config).text)
    assert events[-1][1]["cases"] == ["sub-1", "sub-2"]
    assay = registry.get("assay-001")
    assert set(assay.cohorts) == {"sub-1", "sub-2"}
    assert assay.base_url == "http://localhost:9000/measurements/"
    assert assay.cohorts["sub-2"]["findings_json"] is None


def test_tool_config_missing_dataset_400(client, tool_config):
    tool_config["assay_info"]["datasets"][0]["name"] = "nope"
    response = client.post("/api/tool-config", json=tool_config)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["step"] == "minio"
    assert detail["summary"]
    assert registry.get("assay-001") is None


def test_tool_config_unknown_sample_type_400(client, tool_config):
    tool_config["assay_info"]["datasets"][0]["sample_type"].append("bogus_type")
    response = client.post("/api/tool-config", json=tool_config)
    assert response.status_code == 400
    assert response.json()["detail"]["step"] == "config"


def test_tool_config_rejects_non_http_base_url(client, tool_config):
    tool_config["system"]["minio"]["base_url"] = "ftp://localhost/measurements/"
    response = client.post("/api/tool-config", json=tool_config)
    assert response.status_code == 400
    assert response.json()["detail"]["step"] == "1.1"


def test_registry_put_get():
    registry.clear()
    registry.put(ResolvedAssay(uuid="a", base_url="http://x/", cohorts={"c": {"t": None}}))
    assert registry.get("a").cohorts == {"c": {"t": None}}
    assert registry.get("missing") is None
    registry.clear()
