"""The patient's report: findings plus sizes and slice images measured from the one mask, and
the route that serves it as a cached PDF."""

import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import nibabel as nib
import numpy as np
import pytest

from app.reports import schema
from app.services import report
from app.services.report import (
    ReportUnavailable,
    build_report_html,
    build_report_pdf,
    prepare_report,
    weasyprint_available,
)
from tests.conftest import GRID, ORIGIN_LPS, SPACING

URL = "/api/patients/assay-001/{}/report.pdf"


def _nii_bytes(mask: np.ndarray, spacing=SPACING) -> bytes:
    affine = np.diag([-spacing[0], -spacing[1], spacing[2], 1.0])
    affine[:3, 3] = (-ORIGIN_LPS[0], -ORIGIN_LPS[1], ORIGIN_LPS[2])
    return nib.Nifti1Image.to_bytes(nib.Nifti1Image(mask, affine))


def _with_finding(findings: schema.Findings, channel: int, color="#66bb6a") -> schema.Findings:
    copy = findings.model_copy(deep=True)
    copy.findings.append(
        schema.Finding(
            id=f"f_{channel}",
            label=f"Finding {channel}",
            lesion=schema.Lesion(layer_id="layer1", channel=channel, color=color),
        )
    )
    return copy


# --- Building the report --------------------------------------------------------


def test_report_html_two_findings(loaded_service):
    findings, vol, mask = loaded_service
    html = build_report_html("sub-1", findings, vol, mask, timezone.utc)
    assert "Finding 1" in html and "Finding 2" in html and "Breast Educational Resource" in html
    assert "Medical Image Annotator" not in html and "data:image/png;base64," in html
    assert html.count('class="finding"') == 2
    assert html.count("data:image/png;base64,") == 2


def test_every_card_names_the_clinician_layer(loaded_service):
    # The record anchors sub-1's findings to layer1 ("Model predicted" in the validator), but
    # the sizes and outlines printed beside it come from the Clinician Layer mask.
    assert loaded_service.findings.findings[0].lesion.layer_id == "layer1"
    html = build_report_html("sub-1", *loaded_service, timezone.utc)
    assert "Model predicted" not in html
    assert html.count("Clinician layer · channel") == 2


def test_report_html_names_the_cohort_and_no_reader(loaded_service):
    html = build_report_html("sub-1", *loaded_service, timezone.utc)
    assert '<h1 class="case-name">sub-1</h1>' in html
    assert "Research use. Not for primary diagnostic interpretation." in html


def test_report_html_prints_the_computed_sizes(loaded_service):
    html = build_report_html("sub-1", *loaded_service, timezone.utc)
    assert "3.0 mm" in html  # finding 1's largest extent: two slices of 1.5 mm
    assert "21.1 mm³" in html  # 18 voxels of 0.885 x 0.885 x 1.5 mm
    assert "measured" in html


def test_report_html_no_reading_block(loaded_service):
    # Even a record that carries a finished reading prints no reading time.
    findings = loaded_service.findings.model_copy(deep=True)
    findings.reading_session.state = "finished"
    findings.reading_session.started_at = datetime(2026, 9, 4, 10, 0, tzinfo=timezone.utc)
    findings.reading_session.finished_at = datetime(2026, 9, 4, 10, 7, 30, tzinfo=timezone.utc)
    html = build_report_html("sub-1", findings, loaded_service.volume, loaded_service.mask, timezone.utc)
    assert "Reading time" not in html
    assert "Reading started" not in html
    assert "reading-hero" not in html
    assert "07:30" not in html


def test_sizes_are_filled_and_location_and_assessment_stay_null(loaded_service):
    parts = prepare_report("sub-1", *loaded_service)
    for finding in parts.findings.findings:
        assert finding.size.max_linear_mm is not None
        assert finding.size.max_linear_mm.source == "computed"
        assert finding.location == schema.Location()
        assert finding.assessment is None
    assert parts.findings.assessment.category is None
    assert parts.anatomical_withheld == ""


def test_the_input_findings_are_not_modified(loaded_service):
    prepare_report("sub-1", *loaded_service)
    assert loaded_service.findings.findings[0].size == schema.Size()


def test_a_hand_entered_size_is_kept(loaded_service):
    findings = loaded_service.findings.model_copy(deep=True)
    findings.findings[0].size.volume_mm3 = schema.Measurement(value=99.0, source="manual")
    parts = prepare_report("sub-1", findings, loaded_service.volume, loaded_service.mask)
    size = parts.findings.findings[0].size
    assert size.volume_mm3 == schema.Measurement(value=99.0, source="manual")
    assert size.max_linear_mm.source == "computed"


def test_the_case_is_the_cohort(loaded_service):
    case = prepare_report("sub-1", *loaded_service).case
    assert (case.name, case.id, case.assay_uuid, case.user_uuid) == ("sub-1", "sub-1", None, None)


def test_lesion_images_are_captioned_with_their_axial_slice(loaded_service):
    images = prepare_report("sub-1", *loaded_service).lesion_images
    # Label 1 spans k = 1..2, whose centre of mass (1.5) rounds half up to 2; label 2 sits at k = 4.
    assert images["f_1"]["caption"] == "Contrast phase 1, registered - axial slice 2"
    assert images["f_2"]["caption"] == "Contrast phase 1, registered - axial slice 4"
    assert images["f_1"]["uri"].startswith("data:image/png;base64,")


def test_lesion_image_empty_channel_reason(loaded_service):
    findings = _with_finding(loaded_service.findings, 3)
    html = build_report_html("sub-1", findings, loaded_service.volume, loaded_service.mask, timezone.utc)
    assert "No slice image - this finding has not been segmented." in html
    assert html.count("data:image/png;base64,") == 2


def test_lesion_image_grid_mismatch_reason(loaded_service):
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[2:5, 2:5, 1:3] = 1
    other_grid = _nii_bytes(mask, spacing=(1.0, 1.0, 1.5))
    parts = prepare_report("sub-1", loaded_service.findings, loaded_service.volume, other_grid)
    for finding_id in ("f_1", "f_2"):
        # Plain words on the page; the numbers go to the log.
        assert parts.lesion_images[finding_id] == {"reason": "the outline and the image are not on the same grid"}
    # The sizes still come from the mask, on its own grid.
    assert parts.findings.findings[0].size.max_linear_mm.value == 3.0


def test_an_unreadable_mask_gives_reasons_and_no_sizes(loaded_service):
    parts = prepare_report("sub-1", loaded_service.findings, loaded_service.volume, b"not a mask")
    assert parts.lesion_images == {
        "f_1": {"reason": "the mask could not be read"},
        "f_2": {"reason": "the mask could not be read"},
    }
    assert all(f.size == schema.Size() for f in parts.findings.findings)


def test_an_absent_mask_says_none_was_delivered(loaded_service):
    parts = prepare_report("sub-1", loaded_service.findings, loaded_service.volume, None)
    assert parts.lesion_images["f_1"] == {"reason": "no mask was delivered for this scan"}
    assert all(f.size == schema.Size() for f in parts.findings.findings)


def test_an_unreadable_series_gives_reasons_but_keeps_the_sizes(loaded_service):
    parts = prepare_report("sub-1", loaded_service.findings, b"not a volume", loaded_service.mask)
    assert parts.lesion_images["f_1"] == {"reason": "the post-contrast series could not be read"}
    assert parts.findings.findings[0].size.max_linear_mm.value == 3.0


def test_an_absent_series_says_the_scan_has_none(loaded_service):
    parts = prepare_report("sub-1", loaded_service.findings, None, loaded_service.mask)
    assert parts.lesion_images["f_1"] == {"reason": "this scan has no post-contrast series"}
    assert parts.findings.findings[0].size.max_linear_mm.value == 3.0


def test_one_failing_image_costs_only_that_image(loaded_service, monkeypatch):
    real = report.render_slice_png

    def fails_on_channel_2(volume, mask, channel, *args, **kwargs):
        if channel == 2:
            raise RuntimeError("drawing failed")
        return real(volume, mask, channel, *args, **kwargs)

    monkeypatch.setattr(report, "render_slice_png", fails_on_channel_2)
    html = build_report_html("sub-1", *loaded_service, timezone.utc)
    assert html.count("data:image/png;base64,") == 1
    assert "No slice image - the slice image could not be built." in html


def test_an_invalid_colour_is_outlined_in_the_neutral_colour(loaded_service):
    findings = loaded_service.findings.model_copy(deep=True)
    findings.findings[0].lesion.color = "#fff"
    parts = prepare_report("sub-1", findings, loaded_service.volume, loaded_service.mask)
    assert parts.lesion_images["f_1"]["uri"].startswith("data:image/png;base64,")


def test_build_report_pdf_without_weasyprint_raises_report_unavailable(loaded_service, monkeypatch):
    monkeypatch.setitem(sys.modules, "weasyprint", None)
    with pytest.raises(ReportUnavailable):
        build_report_pdf("sub-1", *loaded_service, timezone.utc)


# --- The route ----------------------------------------------------------------


def test_report_without_findings_404(loaded_client, cache_dir):
    response = loaded_client.get(URL.format("sub-2"))
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "no_findings"


def test_report_for_an_assay_not_loaded_409(client, cache_dir):
    response = client.get(URL.format("sub-1"))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "assay_not_loaded"


@pytest.fixture()
def downloads(monkeypatch):
    """Every object URL the route downloads, in order."""
    from app.services.minio_service import MinIOService

    urls = []
    real_read = MinIOService.read_object_bytes

    def read(self, url):
        urls.append(url)
        return real_read(self, url)

    monkeypatch.setattr(MinIOService, "read_object_bytes", read)
    return urls


def _volumes(urls):
    return [u for u in urls if u.endswith((".nrrd", ".nii.gz"))]


def test_report_unavailable_503(loaded_client, cache_dir, monkeypatch, downloads):
    monkeypatch.setitem(sys.modules, "weasyprint", None)
    response = loaded_client.get(URL.format("sub-1"))
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "report_unavailable",
        "summary": "Report rendering needs the Docker backend.",
    }
    # Refused before any volume is downloaded.
    assert _volumes(downloads) == []


class _Renders(list):
    """The zone of each render; `inputs` holds each render's (volume, mask) bytes."""

    def __init__(self):
        super().__init__()
        self.inputs = []


@pytest.fixture()
def fake_render(monkeypatch):
    """Replaces the PDF renderer, and the WeasyPrint check, with stand-ins that record each render."""
    renders = _Renders()

    def render(cohort, findings, volume, mask, zone):
        renders.append(zone)
        renders.inputs.append((volume, mask))
        return b"%PDF-fake " + str(len(renders)).encode()

    monkeypatch.setattr(report, "require_weasyprint", lambda: None)
    monkeypatch.setattr(report, "build_report_pdf", render)
    return renders


def test_report_response_headers(loaded_client, cache_dir, fake_render):
    response = loaded_client.get(URL.format("sub-1"), params={"tz": "Pacific/Auckland"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'inline; filename="sub-1-mri-report.pdf"'
    assert response.headers["cache-control"] == "no-store"
    assert fake_render == [ZoneInfo("Pacific/Auckland")]


def test_a_report_in_the_same_zone_is_served_from_the_cache(loaded_client, cache_dir, fake_render):
    first = loaded_client.get(URL.format("sub-1"), params={"tz": "Pacific/Auckland"})
    second = loaded_client.get(URL.format("sub-1"), params={"tz": "Pacific/Auckland"})
    assert first.content == second.content
    assert len(fake_render) == 1


def test_a_report_in_another_zone_is_rendered_again(loaded_client, cache_dir, fake_render):
    loaded_client.get(URL.format("sub-1"), params={"tz": "Pacific/Auckland"})
    loaded_client.get(URL.format("sub-1"))
    assert fake_render == [ZoneInfo("Pacific/Auckland"), timezone.utc]


@pytest.mark.parametrize("tz", [None, "", "Mars/Olympus_Mons", "../../etc/passwd"])
def test_no_zone_or_an_unknown_one_is_utc_and_shares_its_cache_entry(loaded_client, cache_dir, fake_render, tz):
    loaded_client.get(URL.format("sub-1"), params={"tz": "UTC"})
    params = {} if tz is None else {"tz": tz}
    assert loaded_client.get(URL.format("sub-1"), params=params).status_code == 200
    assert [str(zone) for zone in fake_render] == ["UTC"]


def test_a_changed_findings_record_is_rendered_again(loaded_client, cache_dir, fake_render, sparc_dataset):
    loaded_client.get(URL.format("sub-1"))
    path = sparc_dataset / "primary" / "sub-1" / "sam-3" / "f.json"
    path.write_text(path.read_text() + "\n")
    loaded_client.get(URL.format("sub-1"))
    assert len(fake_render) == 2


def test_a_failed_download_is_not_cached(loaded_client, cache_dir, fake_render, monkeypatch):
    from app.services.minio_service import MinIOService

    real_read = MinIOService.read_object_bytes

    def nrrd_fails(self, url):
        return None if url.endswith(".nrrd") else real_read(self, url)

    monkeypatch.setattr(MinIOService, "read_object_bytes", nrrd_fails)
    response = loaded_client.get(URL.format("sub-1"))
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "input_unreadable"
    assert fake_render == []

    monkeypatch.setattr(MinIOService, "read_object_bytes", real_read)
    assert loaded_client.get(URL.format("sub-1")).status_code == 200
    assert len(fake_render) == 1


def test_without_a_mask_the_volume_is_not_downloaded(loaded_client, cache_dir, fake_render, sparc_dataset, downloads):
    (sparc_dataset / "primary" / "sub-1" / "sam-2" / "m.nii.gz").unlink()
    assert loaded_client.get(URL.format("sub-1")).status_code == 200
    assert _volumes(downloads) == []
    assert fake_render.inputs == [(None, None)]


def test_a_findings_download_failure_is_503_and_not_cached(loaded_client, cache_dir, fake_render, monkeypatch):
    from app.services.minio_service import MinIOService

    real_read = MinIOService.read_object_bytes
    monkeypatch.setattr(
        MinIOService, "read_object_bytes", lambda self, url: None if url.endswith(".json") else real_read(self, url)
    )
    response = loaded_client.get(URL.format("sub-1"))
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "input_unreadable"

    monkeypatch.setattr(MinIOService, "read_object_bytes", real_read)
    assert loaded_client.get(URL.format("sub-1")).status_code == 200
    assert len(fake_render) == 1


def test_a_changed_report_template_is_rendered_again(loaded_client, cache_dir, fake_render, monkeypatch):
    loaded_client.get(URL.format("sub-1"))
    monkeypatch.setattr(report, "report_version", lambda: "changed")
    loaded_client.get(URL.format("sub-1"))
    assert len(fake_render) == 2


def test_report_version_follows_the_template_sources():
    version = report.report_version()
    assert version and version == report.report_version()
    sources = {path.name for path in report.version_sources()}
    assert {
        "report.html", "report.css", "acr_form_table.json", "template.py", "report.py",
        "canonical.py", "volume_reader.py",
    } <= sources


@pytest.mark.skipif(not weasyprint_available(), reason="WeasyPrint needs GTK; runs in Docker")
def test_report_pdf_renders(loaded_client, cache_dir, monkeypatch):
    first = loaded_client.get(URL.format("sub-1"))
    assert first.status_code == 200
    assert first.content.startswith(b"%PDF")

    def must_not_render(*args, **kwargs):
        raise AssertionError("the second request should be served from the cache")

    monkeypatch.setattr(report, "build_report_pdf", must_not_render)
    second = loaded_client.get(URL.format("sub-1"))
    assert second.status_code == 200
    assert second.content == first.content
