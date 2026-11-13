"""The report template: context building, SVG and HTML, ported from the validator's suite.

Everything here runs on a bare host: `build_context`, `svg` and the Jinja render are free of
WeasyPrint. The one PDF test skips where WeasyPrint cannot load, which is everywhere except the
Docker image.
"""
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.reports.acr_form import ACR_SECTIONS, UNSET, option_title, render_value
from app.reports.schema import (
    CONTRAST_PHASES,
    Assessment,
    BreastTissue,
    Curve,
    Distance,
    Finding,
    Findings,
    Kinetics,
    Lesion,
    Location,
    Measurement,
    Provenance,
    Size,
)
from app.reports.svg import clock_svg, kinetics_svg
from app.reports.template import EM_DASH, build_context, resolve_zone
from app.services.report import weasyprint_available


class StubCase:
    """`build_context` reads exactly these four attributes and nothing else."""

    id = 42
    name = "BC_1042"
    assay_uuid = "a3f9c0de-0000-4000-8000-000000000001"
    user_uuid = "u-0001"


def rich_findings():
    """A two-lesion record with different kinetics: one fast + persistent, one fast + washout,
    in two different bands. Distances and sizes are absent by design."""
    return Findings(
        breast_tissue=BreastTissue(),
        findings=[
            Finding(
                id="f_1",
                label="Finding 1",
                lesion=Lesion(layer_id="layer3", channel=1, color="#ff7043"),
                kinetics=Kinetics(
                    early_phase="fast",
                    delayed_phase="persistent",
                    source="mock",
                    curve=Curve(
                        phases=list(CONTRAST_PHASES),
                        mean_intensity=[312.4, 765.1, 863.0, 893.7, 915.2],
                        percent_change=[0.0, 145.0, 176.3, 186.1, 193.0],
                    ),
                ),
                location=Location(laterality="right", clock_position=2, depth="middle"),
                assessment=2,
            ),
            Finding(
                id="f_2",
                label="Finding 2",
                lesion=Lesion(layer_id="layer3", channel=2, color="#42a5f5"),
                kinetics=Kinetics(
                    early_phase="fast",
                    delayed_phase="washout",
                    source="mock",
                    curve=Curve(
                        phases=list(CONTRAST_PHASES),
                        mean_intensity=[288.0, 633.6, 564.5, 541.4, 524.2],
                        percent_change=[0.0, 120.0, 96.0, 88.0, 82.0],
                    ),
                ),
                location=Location(laterality="right", clock_position=10, depth="posterior"),
                assessment=4,
            ),
        ],
        assessment=Assessment(category=4, source="derived"),
    )


def _context(findings=None):
    return build_context(StubCase(), findings or rich_findings())


# --- Context ------------------------------------------------------------------


def test_context_carries_the_case_identity():
    ctx = _context()
    assert ctx["case_name"] == "BC_1042"
    assert [cell["label"] for cell in ctx["meta"]] == ["Case ID", "Assay", "Generated", "Reader"]
    assert ctx["meta"][0]["value"] == "42"


def test_the_product_is_this_app():
    assert _context()["product"] == "Breast Educational Resource"


def test_the_context_carries_no_reading_session():
    assert "reading" not in _context()


def test_a_case_without_a_reader_shows_an_em_dash_not_an_empty_cell():
    class Anonymous(StubCase):
        user_uuid = None

    ctx = build_context(Anonymous(), rich_findings())
    assert ctx["meta"][3]["value"] == EM_DASH


def test_assessment_quotes_the_acr_management_and_likelihood():
    ctx = _context()
    assert ctx["assessment"]["category"] == "4"
    assert ctx["assessment"]["title"] == "Suspicious"
    assert ctx["assessment"]["management"] == "Tissue diagnosis"
    assert "> 2%" in ctx["assessment"]["likelihood"]
    assert ctx["assessment"]["tone"] == "tone-suspicious"


def test_an_unassessed_case_still_produces_a_hero():
    ctx = _context(Findings(assessment=Assessment(category=None)))
    assert ctx["assessment"]["assessed"] is False
    assert ctx["assessment"]["category"] == EM_DASH
    assert ctx["assessment"]["tone"] == "tone-neutral"


@pytest.mark.parametrize(
    "category,tone",
    [(1, "tone-benign"), (3, "tone-watch"), (5, "tone-malignant"), (6, "tone-known")],
)
def test_each_category_gets_its_tone(category, tone):
    # `source="manual"`: a derived category with no findings resolves to None.
    ctx = _context(Findings(assessment=Assessment(category=category, source="manual")))
    assert ctx["assessment"]["tone"] == tone


def test_a_derived_category_is_recomputed_rather_than_read_from_the_file():
    findings = Findings(
        findings=[Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id="layer3", channel=1), assessment=5)],
        assessment=Assessment(category=1, source="derived"),
    )
    ctx = _context(findings)
    assert ctx["assessment"]["category"] == "5"
    assert ctx["assessment"]["derived"] is True
    assert "Derived" in ctx["assessment"]["source"]


def test_a_manual_category_is_printed_as_the_readers_own():
    findings = Findings(
        findings=[Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id="layer3", channel=1), assessment=5)],
        assessment=Assessment(category=2, source="manual"),
    )
    ctx = _context(findings)
    assert ctx["assessment"]["category"] == "2"
    assert ctx["assessment"]["derived"] is False
    assert ctx["assessment"]["rule"] == ""
    assert "reader" in ctx["assessment"]["source"].lower()


def test_unassessed_breast_tissue_is_marked_not_assessed():
    rows = _context()["breast_tissue"]["rows"]
    assert len(rows) == 3
    assert all(row["assessed"] is False for row in rows)
    assert all(row["value"] == "Not assessed" for row in rows)


def test_assessed_breast_tissue_carries_its_definition():
    rows = _context(Findings(breast_tissue=BreastTissue(bpe_level="minimal")))["breast_tissue"]["rows"]
    bpe = next(r for r in rows if r["label"].startswith("Background"))
    assert bpe["assessed"] is True
    assert bpe["value"] == "Minimal"
    assert bpe["definition"] == "Includes no enhancement"


# --- Findings -----------------------------------------------------------------


def test_each_finding_names_the_mask_it_was_measured_on():
    ctx = _context()
    assert ctx["findings"][0]["layer"] == "Clinician layer"
    assert ctx["findings"][0]["channel"] == 1
    assert ctx["findings"][1]["channel"] == 2


@pytest.mark.parametrize("layer_id", ["layer1", "layer2", "layer3", "findings1"])
def test_every_layer_prints_as_the_clinician_layer(layer_id):
    # Sizes and outlines come from the Clinician Layer mask whatever layer the record names,
    # so "Model predicted" for layer1 would misstate where they were measured.
    findings = Findings(findings=[Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id=layer_id, channel=1))])
    assert _context(findings)["findings"][0]["layer"] == "Clinician layer"


def test_kinetics_rows_carry_the_acr_definitions():
    early, delayed = _context()["findings"][0]["kinetics_rows"]
    assert early["value"] == "Fast"
    assert early["definition"] == "> 100% increase in signal intensity"
    assert delayed["value"] == "Persistent"
    assert "10%" in delayed["definition"]


def test_a_mock_curve_is_labelled_as_a_placeholder():
    assert _context()["findings"][0]["curve_is_mock"] is True


def test_clock_position_is_rendered_in_words_as_well_as_geometry():
    rows = _context()["findings"][0]["location_rows"]
    position = next(r for r in rows if r["label"] == "Location in breast")
    assert position["value"] == "2 o'clock"
    assert position["assessed"] is True


def test_quadrant_is_used_when_no_clock_position_was_given():
    findings = Findings(
        findings=[
            Finding(
                id="f_1",
                label="Finding 1",
                lesion=Lesion(layer_id="layer1", channel=1),
                location=Location(quadrant="UOQ"),
            )
        ]
    )
    rows = _context(findings)["findings"][0]["location_rows"]
    position = next(r for r in rows if r["label"] == "Location in breast")
    assert position["value"] == "Upper outer quadrant"


def test_an_unassessed_location_prints_an_em_dash():
    findings = Findings(findings=[Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id="layer1", channel=1))])
    rows = _context(findings)["findings"][0]["location_rows"]
    assert [r["label"] for r in rows] == ["Laterality", "Location in breast", "Depth"]
    assert all(r["value"] == EM_DASH and r["assessed"] is False for r in rows)


def test_findings_with_no_lesions_render_an_empty_state_rather_than_nothing():
    assert _context(Findings())["findings"] == []


# --- Distance provenance ------------------------------------------------------


def test_unset_distances_print_an_em_dash():
    rows = _context()["findings"][0]["distance_rows"]
    assert [r["label"] for r in rows] == ["From nipple", "From skin", "From ribcage"]
    assert all(r["assessed"] is False for r in rows)
    assert all(r["value"] == EM_DASH for r in rows)


def test_a_measured_distance_prints_its_source_and_capture_time():
    findings = Findings(
        findings=[
            Finding(
                id="f_1",
                label="Finding 1",
                lesion=Lesion(layer_id="layer3", channel=1),
                location=Location(
                    distance_nipple_cm=Distance(
                        value=2.84,
                        source="measured",
                        recorded_at=datetime(2026, 7, 31, 4, 10, 55, tzinfo=timezone.utc),
                    ),
                    distance_skin_cm=Distance(value=1.5, source="manual"),
                ),
            )
        ]
    )
    nipple, skin, ribcage = _context(findings)["findings"][0]["distance_rows"]
    assert nipple["value"] == "2.8 cm"
    assert nipple["source"] == "measured 31 Jul 2026, 04:10 UTC"
    assert skin["value"] == "1.5 cm"
    assert skin["source"] == "entered"
    assert ribcage["assessed"] is False


def test_a_computed_distance_prints_its_source_and_capture_time():
    findings = Findings(
        findings=[
            Finding(
                id="f_1",
                label="Finding 1",
                lesion=Lesion(layer_id="layer3", channel=1),
                location=Location(
                    distance_nipple_cm=Distance(
                        value=2.84,
                        source="computed",
                        recorded_at=datetime(2026, 7, 31, 4, 10, 55, tzinfo=timezone.utc),
                    ),
                ),
            )
        ]
    )
    nipple = _context(findings)["findings"][0]["distance_rows"][0]
    assert nipple["value"] == "2.8 cm"
    assert nipple["source"] == "computed 31 Jul 2026, 04:10 UTC"


# --- Size ---------------------------------------------------------------------


def _sized(**size_kwargs):
    return Findings(
        findings=[Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id="layer3", channel=1), size=Size(**size_kwargs))]
    )


def test_the_five_size_fields_are_printed_in_panel_order():
    rows = _context(_sized())["findings"][0]["size_rows"]
    assert [r["label"] for r in rows] == [
        "Maximum linear dimension",
        "Anteroposterior",
        "Transverse",
        "Craniocaudal",
        "Volume",
    ]


def test_unset_sizes_are_marked_rather_than_left_blank():
    rows = _context(_sized())["findings"][0]["size_rows"]
    assert all(r["assessed"] is False for r in rows)
    assert all(r["value"] == "Not assessed" for r in rows)
    assert all(r["withheld"] is False for r in rows)


def test_a_computed_size_prints_its_source_and_time():
    findings = _sized(
        max_linear_mm=Measurement(
            value=18.42,
            source="computed",
            recorded_at=datetime(2026, 8, 4, 4, 10, 55, tzinfo=timezone.utc),
        ),
        volume_mm3=Measurement(value=1234.5, source="manual"),
    )
    rows = _context(findings)["findings"][0]["size_rows"]
    assert rows[0]["value"] == "18.4 mm"
    assert rows[0]["source"] == "measured 04 Aug 2026, 04:10 UTC"
    assert rows[4]["value"] == "1,234.5 mm³"
    assert rows[4]["source"] == "entered"


def test_a_computed_size_without_a_time_says_measured():
    rows = _context(_sized(max_linear_mm=Measurement(value=3.0, source="computed")))["findings"][0]["size_rows"]
    assert rows[0]["value"] == "3.0 mm"
    assert rows[0]["source"] == "measured"


def test_withheld_anatomical_axes_read_as_a_refusal_not_an_omission():
    findings = _sized(
        max_linear_mm=Measurement(value=18.0, source="manual"),
        volume_mm3=Measurement(value=900.0, source="manual"),
    )
    reason = "Image axis 1 is 30.0 degrees off the nearest patient axis"
    rows = build_context(StubCase(), findings, anatomical_withheld=reason)["findings"][0]["size_rows"]
    ap, transverse, cc = rows[1], rows[2], rows[3]
    assert all(r["withheld"] is True for r in (ap, transverse, cc))
    assert all(r["source"] == "withheld" for r in (ap, transverse, cc))
    assert rows[0]["withheld"] is False
    assert rows[0]["value"] == "18.0 mm"
    assert rows[4]["value"] == "900.0 mm³"


def test_the_withheld_reason_reaches_the_finding_so_the_page_can_explain_itself():
    reason = "Image axis 1 is 30.0 degrees off the nearest patient axis"
    ctx = build_context(StubCase(), _sized(), anatomical_withheld=reason)
    assert ctx["findings"][0]["size_withheld_note"] == reason


# --- Band grouping ------------------------------------------------------------


def _assessed(*categories):
    return Findings(
        findings=[
            Finding(id=f"f_{i}", label=f"Finding {i}", lesion=Lesion(layer_id="layer3", channel=i), assessment=category)
            for i, category in enumerate(categories, start=1)
        ]
    )


def test_findings_are_grouped_most_severe_first():
    groups = _context(_assessed(2, 4, None, 6))["finding_groups"]
    assert [g["key"] for g in groups] == ["malignant", "suspicious", "benign", "unassessed"]
    assert [g["title"] for g in groups] == [
        "Malignant findings",
        "Suspicious findings",
        "Benign findings",
        "Unassessed findings",
    ]
    assert [g["count"] for g in groups] == [1, 1, 1, 1]


def test_an_empty_group_is_dropped_rather_than_printed_empty():
    ctx = _context(_assessed(3, 4))
    assert [g["key"] for g in ctx["finding_groups"]] == ["suspicious"]
    assert ctx["finding_groups"][0]["count"] == 2


def test_every_finding_appears_exactly_once_across_the_groups():
    ctx = _context(_assessed(2, 4, None))
    grouped = [f["label"] for g in ctx["finding_groups"] for f in g["findings"]]
    assert sorted(grouped) == ["Finding 1", "Finding 2", "Finding 3"]
    assert len(ctx["findings"]) == 3


def test_incomplete_and_unassessed_share_a_band():
    ctx = _context(_assessed(0, None))
    assert [g["key"] for g in ctx["finding_groups"]] == ["unassessed"]
    assert ctx["finding_groups"][0]["count"] == 2


def test_a_finding_carries_its_own_assessment_and_band():
    finding = _context(_assessed(4))["finding_groups"][0]["findings"][0]
    assert finding["group"] == "suspicious"
    assert finding["group_label"] == "Suspicious"
    assert finding["assessment"]["category"] == "4"
    assert finding["assessment"]["title"] == "Suspicious"
    assert finding["assessment"]["tone"] == "tone-suspicious"


def test_an_unassessed_finding_prints_a_dash_rather_than_a_number():
    finding = _context(_assessed(None))["finding_groups"][0]["findings"][0]
    assert finding["group"] == "unassessed"
    assert finding["assessment"]["category"] == EM_DASH
    assert finding["assessment"]["assessed"] is False


def test_incomplete_keeps_its_number_on_the_card():
    finding = _context(_assessed(0))["finding_groups"][0]["findings"][0]
    assert finding["group"] == "unassessed"
    assert finding["assessment"]["category"] == "0"
    assert finding["assessment"]["assessed"] is True


def test_the_card_badge_cannot_contradict_its_band():
    for group in _context(_assessed(1, 3, 5, 0))["finding_groups"]:
        for finding in group["findings"]:
            assert finding["group"] == group["key"]


# --- Provenance tags ----------------------------------------------------------


def _provenance(**kwargs):
    return Findings(
        findings=[
            Finding(id="f_1", label="Finding 1", lesion=Lesion(layer_id="layer3", channel=1), provenance=Provenance(**kwargs))
        ]
    )


def test_an_untouched_finding_carries_no_tags():
    assert _context(_sized())["findings"][0]["provenance_tags"] == []


def test_an_edited_mask_is_tagged_with_its_time():
    findings = _provenance(mask_edited=True, mask_edited_at=datetime(2026, 8, 4, 9, 5, 0, tzinfo=timezone.utc))
    assert _context(findings)["findings"][0]["provenance_tags"] == ["Mask edited by hand at 04 Aug 2026, 09:05 UTC"]


def test_an_ai_merged_mask_is_tagged_as_the_model_s_work_not_the_clinician_s():
    findings = _provenance(mask_ai_merged=True, mask_ai_merged_at=datetime(2026, 8, 10, 9, 5, 0, tzinfo=timezone.utc))
    assert _context(findings)["findings"][0]["provenance_tags"] == ["Mask merged from AI at 10 Aug 2026, 09:05 UTC"]


def test_an_ai_merge_and_a_hand_edit_are_tagged_as_two_separate_events():
    findings = _provenance(
        mask_edited=True,
        mask_edited_at=datetime(2026, 8, 10, 10, 30, 0, tzinfo=timezone.utc),
        mask_ai_merged=True,
        mask_ai_merged_at=datetime(2026, 8, 10, 9, 5, 0, tzinfo=timezone.utc),
    )
    assert _context(findings)["findings"][0]["provenance_tags"] == [
        "Mask merged from AI at 10 Aug 2026, 09:05 UTC",
        "Mask edited by hand at 10 Aug 2026, 10:30 UTC",
    ]


def test_an_overridden_measurement_is_tagged_separately_from_the_mask():
    findings = _sized(max_linear_mm=Measurement(value=18.0, source="manual"))
    assert _context(findings)["findings"][0]["provenance_tags"] == ["Measurement overridden by hand"]


def test_both_tags_appear_when_both_happened():
    findings = Findings(
        findings=[
            Finding(
                id="f_1",
                label="Finding 1",
                lesion=Lesion(layer_id="layer3", channel=1),
                size=Size(volume_mm3=Measurement(value=900.0, source="manual")),
                provenance=Provenance(mask_edited=True, mask_edited_at=datetime(2026, 8, 4, 9, 5, 0, tzinfo=timezone.utc)),
            )
        ]
    )
    assert len(_context(findings)["findings"][0]["provenance_tags"]) == 2


# --- SVG ----------------------------------------------------------------------


def test_kinetics_svg_draws_a_point_per_phase():
    curve = rich_findings().findings[0].kinetics.curve
    svg = kinetics_svg(curve, "fast", "persistent")
    assert svg.startswith("<svg")
    assert svg.count("<circle") == len(curve.percent_change)
    assert svg.count("<polyline") == 2  # early run + delayed run
    assert "#be123c" in svg  # fast
    assert "#1d4ed8" in svg  # persistent


def test_kinetics_svg_colours_a_washout_curve_differently():
    svg = kinetics_svg(rich_findings().findings[1].kinetics.curve, "fast", "washout")
    assert "#1d4ed8" not in svg


def test_an_empty_curve_renders_the_awaiting_segmentation_placeholder():
    svg = kinetics_svg(Curve())
    assert "Awaiting segmentation" in svg
    assert "<polyline" not in svg


def test_a_curve_with_no_delayed_phase_draws_only_the_early_run():
    curve = Curve(phases=["contrast_pre", "contrast_1"], mean_intensity=[100.0, 250.0], percent_change=[0.0, 150.0])
    assert kinetics_svg(curve, "fast", None).count("<polyline") == 1


def test_kinetics_svg_labels_the_phases_it_actually_has():
    curve = Curve(
        phases=["contrast_pre", "contrast_1", "contrast_3"],
        mean_intensity=[100.0, 250.0, 270.0],
        percent_change=[0.0, 150.0, 170.0],
    )
    svg = kinetics_svg(curve, "fast", "persistent")
    assert ">pre<" in svg
    assert ">1<" in svg
    assert ">3<" in svg
    assert ">2<" not in svg


def test_clock_svg_marks_the_position_and_states_the_side():
    svg = clock_svg(2, "right")
    assert svg.startswith("<svg")
    assert ">R<" in svg
    assert "#be123c" in svg  # the marker


def test_clock_svg_without_a_position_still_draws_the_dial():
    svg = clock_svg(None, None)
    assert "<circle" in svg
    assert "#be123c" not in svg


# --- HTML and PDF -------------------------------------------------------------


def test_html_renders_with_every_section():
    from app.reports.render import render_report_html

    html = render_report_html(StubCase(), rich_findings())
    assert "BI-RADS" in html
    assert "Breast Educational Resource" in html
    assert "Medical Image Annotator" not in html
    assert "BC_1042" in html
    assert "breast tissue" in html.lower()
    assert "examination assessment" in html.lower()
    assert html.count('class="finding"') == 2
    assert "Research use. Not for primary diagnostic interpretation." in html
    assert "<svg" in html


def test_html_escapes_a_hostile_case_name():
    from app.reports.render import render_report_html

    class Hostile(StubCase):
        name = "<script>alert(1)</script>"

    html = render_report_html(Hostile(), Findings())
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_a_finished_reading_prints_no_reading_block():
    from app.reports.render import render_report_html

    findings = rich_findings()
    findings.reading_session.state = "finished"
    findings.reading_session.started_at = datetime(2026, 9, 4, 10, 0, tzinfo=timezone.utc)
    findings.reading_session.finished_at = datetime(2026, 9, 4, 10, 7, 30, tzinfo=timezone.utc)
    html = render_report_html(StubCase(), findings)
    assert "Reading time" not in html
    assert "reading-hero" not in html
    assert "07:30" not in html


@pytest.mark.skipif(not weasyprint_available(), reason="WeasyPrint needs GTK; runs in Docker")
def test_pdf_renders():
    from app.reports.render import render_report_pdf

    pdf = render_report_pdf(StubCase(), rich_findings())
    assert pdf[:5] == b"%PDF-"
    # Two vector curves and a clock each.
    assert len(pdf) > 10_000


# --- ACR form -----------------------------------------------------------------


def _rows(sections):
    return [row for sec in sections for row in sec["rows"]]


def test_every_acr_section_and_field_reaches_the_context():
    f = rich_findings()
    f.acr_case["cysts"] = True
    f.findings[0].acr_lesion["shape"] = "oval"
    ctx = _context(f)

    case_rows = _rows(ctx["acr"]["case"])
    ids = [r["id"] for r in case_rows]
    assert "cysts" in ids
    # Unfilled fields print too: the report shows the whole form.
    assert "hamartoma" in ids
    assert next(r for r in case_rows if r["id"] == "cysts")["text"] == "Yes"
    assert next(r for r in case_rows if r["id"] == "hamartoma")["text"] == UNSET

    lesion_rows = _rows(ctx["acr"]["lesions"][f.findings[0].id])
    assert next(r for r in lesion_rows if r["id"] == "shape")["text"] == "Oval"


def test_bound_fields_are_not_printed_twice():
    ids = [r["id"] for r in _rows(_context()["acr"]["case"])]
    for bound in ("fgt", "bpe_level", "assessment"):
        assert bound not in ids


def test_acr_lesion_sections_render_in_html():
    from app.reports.render import render_report_html

    f = rich_findings()
    f.findings[0].acr_lesion["shape"] = "oval"
    f.findings[0].acr_lesion["other_anatomic"] = "Some text"
    html = render_report_html(StubCase(), f)
    assert "C. Masses" in html
    assert "D. Non-mass enhancement (NME)" in html
    assert "G. Associated features" in html
    assert "I. Location of finding" in html
    assert "Oval" in html
    assert UNSET in html


def test_render_value_prints_an_em_dash_for_unset():
    assert render_value("cysts", None) == UNSET
    assert render_value("cysts", False) == UNSET
    assert render_value("cysts", True) == "Yes"
    assert render_value("quadrant", "UOQ") == "Upper outer quadrant (UOQ)"
    assert render_value("distance_nipple", 3.5) == "3.5"
    assert option_title("quadrant", "central") == "Central"


def test_every_acr_field_id_is_unique():
    ids = [f.id for s in ACR_SECTIONS for f in s.fields]
    assert len(ids) == len(set(ids))


def test_the_unset_mark_matches_the_template_s():
    assert UNSET == EM_DASH


# --- Page breaks --------------------------------------------------------------
# WeasyPrint is not installed outside the container, so the suite cannot rasterise. It can pin
# the rules whose absence is the defect.


def _report_css():
    return (Path(__file__).resolve().parents[1] / "app" / "reports" / "report.css").read_text(encoding="utf-8")


def _declarations(css, selector):
    """Every rule body for one exact selector, comments stripped (a comment that explains a
    missing declaration would otherwise match it)."""
    bodies = re.findall(re.escape(selector) + r"\s*\{([^}]*)\}", css)
    assert bodies, f"no rule for {selector}"
    return re.sub(r"/\*[\s\S]*?\*/", "", "\n".join(bodies))


def test_a_finding_card_is_breakable():
    # A `break-inside: avoid` block taller than a page strands whatever preceded it.
    assert "break-inside" not in _declarations(_report_css(), ".finding")


def test_what_must_not_split_still_says_so():
    css = _report_css()
    assert "break-inside: avoid" in _declarations(css, ".finding-cols")
    assert "break-inside: avoid" in _declarations(css, ".measure")


def test_a_group_heading_still_holds_on_to_its_first_finding():
    assert "break-after: avoid" in _declarations(_report_css(), ".section-head")


# --- Time zone ----------------------------------------------------------------


def _edited_at(at):
    return _provenance(mask_edited=True, mask_edited_at=at)


def test_a_stamp_prints_in_the_reader_s_zone_with_its_own_date():
    # 21:51 UTC on 22 October is 10:51 the next morning in Auckland.
    findings = _edited_at(datetime(2026, 10, 22, 21, 51, tzinfo=timezone.utc))
    ctx = build_context(StubCase(), findings, zone=resolve_zone("Pacific/Auckland"))
    assert ctx["findings"][0]["provenance_tags"] == ["Mask edited by hand at 23 Oct 2026, 10:51 NZDT"]


def test_each_stamp_takes_the_offset_of_its_own_date():
    findings = _edited_at(datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc))
    ctx = build_context(StubCase(), findings, zone=resolve_zone("Pacific/Auckland"))
    assert ctx["findings"][0]["provenance_tags"] == ["Mask edited by hand at 01 Jul 2026, 12:00 NZST"]


def test_the_header_carries_the_zone_too():
    ctx = build_context(StubCase(), rich_findings(), zone=resolve_zone("Pacific/Auckland"))
    assert ctx["meta"][2]["value"].endswith(("NZST", "NZDT"))
    assert ctx["updated_at"].endswith(("NZST", "NZDT"))


@pytest.mark.parametrize("name", [None, "", "Mars/Olympus_Mons", "../../etc/passwd"])
def test_no_zone_or_an_unknown_one_prints_utc_and_says_so(name):
    findings = _edited_at(datetime(2026, 10, 22, 21, 51, tzinfo=timezone.utc))
    ctx = build_context(StubCase(), findings, zone=resolve_zone(name))
    assert ctx["findings"][0]["provenance_tags"] == ["Mask edited by hand at 22 Oct 2026, 21:51 UTC"]
