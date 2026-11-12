"""`findings_json` v3 — the schema the router validates every PUT against.

This file is what pins the v1 -> v2 -> v3 migration contract, so the version in this line
is load-bearing: it says which schema the assertions below describe.

A malformed payload must be a 422, never a corrupt file that breaks the next PDF render.
"""
import pytest
from pydantic import ValidationError

from app.reports.schema import (
    CONTRAST_PHASES,
    MAX_CHANNEL,
    SCHEMA_VERSION,
    Assessment,
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
    dumps,
    empty_findings,
    field_modified,
    loads,
)
from app.utils.setup import Config


def _finding(**overrides):
    base = {
        "id": "f_1",
        "label": "Finding 1",
        "lesion": Lesion(layer_id="layer3", channel=1),
    }
    base.update(overrides)
    return Finding(**base)


# --- The constants this module duplicates must match their sources -------------


def test_config_contrast_inputs_are_known_phases():
    used = [name[: -len("_nrrd")] for name in Config.INPUTS if name.startswith("contrast_")]
    assert used and all(phase in CONTRAST_PHASES for phase in used)


# --- Round trip ---------------------------------------------------------------


def test_the_empty_seed_asserts_nothing():
    # A case with no delivered reading must not arrive carrying invented lesions. The mock
    # this replaced asserted laterality, clock positions, kinetics and BI-RADS categories,
    # and those were rendered into a clinical PDF.
    seeded = empty_findings()
    assert seeded.findings == []
    assert seeded.assessment.category is None
    assert seeded.assessment.source == "derived"
    assert seeded.breast_tissue.fgt is None


def test_the_empty_seed_round_trips():
    restored = loads(dumps(empty_findings()))
    assert restored.schema_version == SCHEMA_VERSION
    assert restored.findings == []


def test_the_mock_seed_is_gone():
    # It was reachable from main.py and findings.py. Keeping it "just for tests" is what
    # made it reachable in the first place; the rich record lives in tests/ now.
    import app.reports.schema as schema
    assert not hasattr(schema, "mock_findings")


def test_kinetics_source_accepts_provided():
    # A curve that arrived in the input dataset is neither illustrative nor computed here.
    assert Kinetics(source="provided").source == "provided"


def test_kinetics_source_accepts_model_predicted():
    # The delivered findings_json says this. A two-value literal rejected the whole document.
    assert Kinetics(source="model_predicted").source == "model_predicted"


def test_an_empty_findings_document_is_valid():
    # A case whose lesions have not been enumerated yet is a legal state.
    empty = Findings()
    assert empty.findings == []
    assert empty.assessment.category is None
    assert loads(dumps(empty)).findings == []


# --- Lesion anchor ------------------------------------------------------------


@pytest.mark.parametrize("channel", [0, MAX_CHANNEL + 1, -1])
def test_channel_outside_the_cap_is_rejected(channel):
    # Driven off the constant, not a literal. Written as `9` this asserted the cap itself,
    # so raising the cap made it fail for the one reason it should not have -- and hid
    # whether the rejection still worked at all.
    with pytest.raises(ValidationError):
        Lesion(layer_id="layer3", channel=channel)


def test_the_highest_offered_channel_is_accepted():
    assert Lesion(layer_id="layer3", channel=MAX_CHANNEL)


def test_unknown_layer_id_is_rejected():
    with pytest.raises(ValidationError):
        Lesion(layer_id="layer4", channel=1)


def test_two_findings_cannot_claim_the_same_channel():
    with pytest.raises(ValidationError, match="same layer and channel"):
        Findings(
            findings=[
                _finding(id="f_1"),
                _finding(id="f_2"),
            ]
        )


def test_the_same_channel_on_different_layers_is_fine():
    doc = Findings(
        findings=[
            _finding(id="f_1", lesion=Lesion(layer_id="layer1", channel=1)),
            _finding(id="f_2", lesion=Lesion(layer_id="layer3", channel=1)),
        ]
    )
    assert len(doc.findings) == 2


def test_finding_ids_must_be_unique():
    with pytest.raises(ValidationError, match="unique"):
        Findings(
            findings=[
                _finding(id="f_1", lesion=Lesion(layer_id="layer1", channel=1)),
                _finding(id="f_1", lesion=Lesion(layer_id="layer3", channel=2)),
            ]
        )


# --- Curve --------------------------------------------------------------------


def test_the_three_curve_arrays_must_be_parallel():
    with pytest.raises(ValidationError, match="same length"):
        Curve(
            phases=["contrast_pre", "contrast_1"],
            mean_intensity=[10.0, 20.0],
            percent_change=[0.0],
        )


def test_a_missing_phase_is_legal_when_all_three_arrays_agree():
    curve = Curve(
        phases=["contrast_pre", "contrast_1", "contrast_3"],
        mean_intensity=[10.0, 25.0, 27.0],
        percent_change=[0.0, 150.0, 170.0],
    )
    assert len(curve.phases) == 3


def test_phases_out_of_acquisition_order_are_rejected():
    with pytest.raises(ValidationError, match="acquisition order"):
        Curve(
            phases=["contrast_1", "contrast_pre"],
            mean_intensity=[25.0, 10.0],
            percent_change=[0.0, -60.0],
        )


def test_repeated_phases_are_rejected():
    with pytest.raises(ValidationError, match="not repeat"):
        Curve(
            phases=["contrast_1", "contrast_1"],
            mean_intensity=[25.0, 25.0],
            percent_change=[0.0, 0.0],
        )


def test_unknown_phase_names_are_rejected():
    with pytest.raises(ValidationError, match="unknown contrast phases"):
        Curve(
            phases=["contrast_9"],
            mean_intensity=[1.0],
            percent_change=[0.0],
        )


def test_the_baseline_percent_change_must_be_zero():
    with pytest.raises(ValidationError, match="must be 0"):
        Curve(
            phases=["contrast_pre", "contrast_1"],
            mean_intensity=[10.0, 25.0],
            percent_change=[5.0, 150.0],
        )


# --- Location -----------------------------------------------------------------


def test_clock_position_and_quadrant_are_mutually_exclusive():
    with pytest.raises(ValidationError, match="mutually exclusive"):
        Location(clock_position=2, quadrant="UOQ")


def test_either_notation_alone_is_fine():
    assert Location(clock_position=2).quadrant is None
    assert Location(quadrant="UOQ").clock_position is None
    assert Location().clock_position is None


@pytest.mark.parametrize("position", [0, 13])
def test_clock_position_outside_the_dial_is_rejected(position):
    with pytest.raises(ValidationError):
        Location(clock_position=position)


# --- Distance provenance ------------------------------------------------------


def test_a_manual_distance_must_not_claim_a_record_time():
    with pytest.raises(ValidationError, match="recorded_at"):
        Distance(value=2.8, source="manual", recorded_at="2026-07-31T04:10:55Z")


def test_a_valid_measured_distance():
    d = Distance(value=2.8, source="measured", recorded_at="2026-07-31T04:10:55Z")
    assert d.value == 2.8
    assert d.recorded_at is not None


def test_a_computed_distance_is_accepted():
    # The data provider can compute a distance from the mask and anatomical landmarks.
    # That is neither spheres placed in this app nor a number a clinician typed.
    d = Distance(value=2.8, source="computed", recorded_at="2026-08-09T00:00:00Z")
    assert d.source == "computed"


@pytest.mark.parametrize("source", ["measured", "computed"])
def test_a_machine_distance_may_omit_its_record_time(source):
    # Never required. An upstream producer has no honest answer for when it computed a
    # number, and demanding one only buys a fabricated timestamp in a clinical record.
    d = Distance(value=2.8, source=source)
    assert d.recorded_at is None


def test_negative_distances_are_rejected():
    with pytest.raises(ValidationError):
        Distance(value=-1.0, source="manual")


# --- Assessment ---------------------------------------------------------------


@pytest.mark.parametrize("category", [0, 1, 2, 3, 4, 5, 6])
def test_every_acr_category_is_accepted(category):
    assert Findings(assessment={"category": category}).assessment.category == category


@pytest.mark.parametrize("category", [-1, 7])
def test_categories_outside_zero_to_six_are_rejected(category):
    with pytest.raises(ValidationError):
        Findings(assessment={"category": category})


def test_an_exam_assessment_defaults_to_derived():
    assert Assessment().source == "derived"


# --- Measurement --------------------------------------------------------------
# The twin of Distance, and it enforces the same shape of rule: the record time is never
# required, and a number that claims to be typed must not carry one.


def test_a_computed_measurement_may_omit_its_record_time():
    m = Measurement(value=12.0, source="computed")
    assert m.recorded_at is None


def test_a_manual_measurement_must_not_claim_a_record_time():
    with pytest.raises(ValidationError, match="recorded_at"):
        Measurement(value=12.0, source="manual", recorded_at="2026-08-04T04:10:00Z")


def test_a_valid_computed_measurement():
    m = Measurement(value=12.0, source="computed", recorded_at="2026-08-04T04:10:00Z")
    assert m.value == 12.0
    assert m.recorded_at is not None


def test_a_valid_manual_measurement():
    m = Measurement(value=12.0, source="manual")
    assert m.source == "manual"
    assert m.recorded_at is None


def test_the_two_models_name_their_timestamp_alike():
    # One concept, one name. Two names for "when this number came into existence" bought
    # nothing and cost every reader of the delivery spec a paragraph explaining which was
    # which. Twin of `IDistance` / `IMeasurement` in `src/models/findings.ts`.
    assert "recorded_at" in Distance.model_fields
    assert "recorded_at" in Measurement.model_fields


def test_negative_measurements_are_rejected():
    with pytest.raises(ValidationError):
        Measurement(value=-1.0, source="manual")


def test_a_size_defaults_to_every_field_unset():
    size = Size()
    assert size.max_linear_mm is None
    assert size.ap_mm is None
    assert size.transverse_mm is None
    assert size.craniocaudal_mm is None
    assert size.volume_mm3 is None


# --- Provenance ---------------------------------------------------------------


def test_an_edited_mask_must_carry_its_edit_time():
    with pytest.raises(ValidationError):
        Provenance(mask_edited=True)


def test_an_edit_time_without_an_edit_is_rejected():
    with pytest.raises(ValidationError):
        Provenance(mask_edited=False, mask_edited_at="2026-08-04T04:10:00Z")


def test_provenance_defaults_to_untouched():
    p = Provenance()
    assert p.mask_edited is False
    assert p.mask_edited_at is None


def test_an_ai_merged_mask_must_carry_its_merge_time():
    with pytest.raises(ValidationError):
        Provenance(mask_ai_merged=True)


def test_a_merge_time_without_a_merge_is_rejected():
    with pytest.raises(ValidationError):
        Provenance(mask_ai_merged=False, mask_ai_merged_at="2026-08-10T04:10:00Z")


def test_provenance_defaults_to_never_ai_merged():
    p = Provenance()
    assert p.mask_ai_merged is False
    assert p.mask_ai_merged_at is None


def test_an_ai_merge_is_not_a_hand_edit():
    # The whole point of the split: a mask a model produced must not read as one a
    # clinician drew. Setting one flag must leave the other alone.
    p = Provenance(mask_ai_merged=True, mask_ai_merged_at="2026-08-10T04:10:00Z")
    assert p.mask_edited is False


def test_a_finding_can_be_both_ai_merged_and_hand_edited():
    # Merging an AI mask and then correcting it by hand is two things that both happened.
    # Neither flag clears the other.
    p = Provenance(
        mask_edited=True,
        mask_edited_at="2026-08-10T05:00:00Z",
        mask_ai_merged=True,
        mask_ai_merged_at="2026-08-10T04:10:00Z",
    )
    assert p.mask_edited is True
    assert p.mask_ai_merged is True


def test_a_document_written_before_the_split_still_loads():
    # v2 documents have no ai-merge fields. They must load as "never AI merged", not fail.
    p = Provenance(mask_edited=True, mask_edited_at="2026-08-04T04:10:00Z")
    assert p.mask_ai_merged is False


# --- field_modified: derived, never stored ------------------------------------


def test_a_finding_with_no_measurements_is_not_field_modified():
    assert field_modified(_finding()) is False


def test_a_manual_size_makes_a_finding_field_modified():
    finding = _finding(size=Size(max_linear_mm=Measurement(value=18.0, source="manual")))
    assert field_modified(finding) is True


def test_a_computed_size_does_not_make_a_finding_field_modified():
    finding = _finding(
        size=Size(
            max_linear_mm=Measurement(
                value=18.0, source="computed", recorded_at="2026-08-04T04:10:00Z"
            )
        )
    )
    assert field_modified(finding) is False


def test_a_manual_distance_makes_a_finding_field_modified():
    finding = _finding(
        location=Location(distance_nipple_cm=Distance(value=2.8, source="manual"))
    )
    assert field_modified(finding) is True


def test_a_measured_distance_does_not_make_a_finding_field_modified():
    finding = _finding(
        location=Location(
            distance_nipple_cm=Distance(
                value=2.8, source="measured", recorded_at="2026-08-04T04:10:00Z"
            )
        )
    )
    assert field_modified(finding) is False


def test_a_computed_distance_does_not_make_a_finding_field_modified():
    # Only `manual` means a human overrode a number. A computed distance is machine output.
    finding = _finding(
        location=Location(
            distance_nipple_cm=Distance(
                value=2.8, source="computed", recorded_at="2026-08-09T00:00:00Z"
            )
        )
    )
    assert field_modified(finding) is False


def test_lexicon_selections_alone_do_not_count_as_field_modification():
    # Every lexicon value is chosen by a human. Counting them would mark every finding that
    # has been read at all, which would make the flag meaningless.
    finding = _finding(location=Location(laterality="right", depth="middle", clock_position=2))
    assert field_modified(finding) is False


# --- The removed `triage` field -----------------------------------------------
# A finding's band used to be a stored field that could contradict its category. It is now
# derived from the category (`lexicon.group_of`), so the field is gone. These pin that a
# document still carrying one is readable rather than a 422 — a clinician's saved reading
# must not become unopenable because the model changed under it.


TRIAGED_DOCUMENT = """
{
  "schema_version": 2,
  "updated_at": "2026-08-04T10:00:00Z",
  "breast_tissue": {},
  "findings": [
    {
      "id": "f_1",
      "label": "Finding 1",
      "lesion": {"layer_id": "layer3", "channel": 1},
      "triage": "benign",
      "assessment": 5
    }
  ],
  "assessment": {"category": 5, "source": "derived"}
}
"""


def test_a_document_carrying_triage_still_loads():
    restored = loads(TRIAGED_DOCUMENT)
    assert len(restored.findings) == 1
    assert restored.findings[0].assessment == 5


def test_a_stored_triage_is_discarded_rather_than_migrated():
    # The fixture files this finding under "benign" while assessing it 5 — exactly the
    # contradiction the old model allowed. The stored band is dropped and the finding groups
    # by the category it actually carries, so the contradiction cannot survive the load.
    finding = loads(TRIAGED_DOCUMENT).findings[0]
    assert not hasattr(finding, "triage")
    assert finding.assessment == 5


def test_the_model_cannot_be_given_a_triage():
    finding = _finding(triage="benign", assessment=2)
    assert not hasattr(finding, "triage")


# --- v1 -> v2 -----------------------------------------------------------------
# v2 must be additive. A findings_json written before this change has to keep loading, or
# every case saved under v1 becomes unreadable and its report un-renderable.


V1_DOCUMENT = """
{
  "schema_version": 1,
  "updated_at": "2026-07-31T10:00:00Z",
  "breast_tissue": {"fgt": "scattered", "bpe_level": "mild", "bpe_symmetry": "symmetric"},
  "findings": [
    {
      "id": "f_1",
      "label": "Finding 1",
      "lesion": {"layer_id": "layer3", "channel": 1, "color": "#ff7043"},
      "kinetics": {
        "early_phase": "fast",
        "delayed_phase": "washout",
        "source": "mock",
        "curve": {
          "phases": ["contrast_pre", "contrast_1"],
          "mean_intensity": [300.0, 700.0],
          "percent_change": [0.0, 133.3]
        }
      },
      "location": {"laterality": "left", "clock_position": 9, "depth": "anterior"}
    }
  ],
  "assessment": {"category": 4}
}
"""


def test_a_v1_document_still_loads():
    restored = loads(V1_DOCUMENT)
    assert len(restored.findings) == 1
    assert restored.findings[0].location.laterality == "left"


def test_a_v1_document_gains_the_v2_fields_as_empty():
    finding = loads(V1_DOCUMENT).findings[0]
    assert finding.size.max_linear_mm is None
    assert finding.assessment is None
    assert finding.provenance.mask_edited is False


def test_a_v1_exam_assessment_is_treated_as_derived():
    # v1 had no `source`, and a v1 category was whatever the clinician picked directly. It
    # defaults to "derived" so the next save recomputes it rather than pinning a stale value
    # that no longer matches the findings.
    assert loads(V1_DOCUMENT).assessment.source == "derived"


def test_a_v1_document_re_saves_as_v2():
    restored = loads(V1_DOCUMENT)
    # `loads` preserves whatever schema_version the file carried; the router stamps the
    # current one on save. What matters here is that a v2 dump of it round-trips.
    reloaded = loads(dumps(restored))
    assert reloaded.findings[0].lesion.channel == 1


# --- v2 -> v3 -------------------------------------------------------------------
# v3 is additive: the ACR lexicon maps, the reading session, and the category-0 reason are
# all optional with empty defaults, so a v2 file parses as v3 with the new fields unset.


def test_v3_defaults_are_all_empty():
    f = Findings()
    assert f.schema_version == 3
    assert f.acr_case == {}
    assert f.reading_session.state == "not_started"
    assert f.reading_session.started_at is None
    assert f.reading_session.finished_at is None
    assert f.reading_session.visited_steps == []
    assert f.reading_session.current_step is None
    assert f.reading_session.finished_incomplete is False
    assert f.assessment.zero_reason is None


def test_a_v2_document_loads_and_gains_v3_fields():
    # A v2 file has none of the v3 members. It must parse, not 422.
    doc = {
        "schema_version": 2,
        "breast_tissue": {"fgt": "scattered"},
        "findings": [],
        "assessment": {"category": 3, "source": "manual"},
    }
    f = Findings.model_validate(doc)
    assert f.breast_tissue.fgt == "scattered"
    assert f.assessment.category == 3
    assert f.assessment.zero_reason is None
    assert f.acr_case == {}
    assert f.reading_session.state == "not_started"


def test_acr_maps_accept_str_float_bool_and_round_trip():
    f = Findings(acr_case={"cysts": True, "ln_axillary": "normal"})
    restored = Findings.model_validate(f.model_dump(mode="json"))
    assert restored.acr_case == {"cysts": True, "ln_axillary": "normal"}


def test_zero_reason_round_trips_for_both_category_zeros():
    for reason in ("additional_imaging", "prior_comparison"):
        f = Findings(assessment=Assessment(category=0, source="manual", zero_reason=reason))
        restored = Findings.model_validate(f.model_dump(mode="json"))
        assert restored.assessment.category == 0
        assert restored.assessment.zero_reason == reason


def test_reading_session_round_trips():
    f = Findings()
    f.reading_session.state = "finished"
    f.reading_session.visited_steps = ["exam:fgt", "assess"]
    f.reading_session.current_step = "assess"
    f.reading_session.finished_incomplete = True
    restored = Findings.model_validate(f.model_dump(mode="json"))
    assert restored.reading_session.state == "finished"
    assert restored.reading_session.visited_steps == ["exam:fgt", "assess"]
    assert restored.reading_session.current_step == "assess"
    assert restored.reading_session.finished_incomplete is True
