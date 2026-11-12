"""`findings_json` v3 — the schema.

This file is the contract for the findings record. It reads v1 and v2 documents and writes v3.
This app only re-serialises a record it read, without bumping its version.

Design notes worth keeping in view while reading:

- Every lexicon value is nullable. `None` means "not assessed" and renders as an explicit
  placeholder. There is no "unknown" sentinel string.
- A finding is a lesion, anchored to `{layer_id, channel}` — the app's existing multi-lesion
  mechanism (mask layers carry channels 1..MAX_CHANNEL). Findings do not invent their own
  numbering.
- A finding is phase-invariant. The only phase-aware structure is the kinetics curve, which
  samples one ROI across the contrast phases.
- Distances are never seeded. A distance may only be written by an explicit capture from the
  live measurement or by typing, because the live DTS/DTN/DTR belong to whichever spheres are
  currently placed rather than to any particular lesion.
- Numbers that a machine can produce carry where they came from. `Distance` distinguishes
  three origins (`measured`, `computed`, `manual`); `Measurement` distinguishes machine from
  human (`computed` vs `manual`). Both print their provenance in the report, and for both,
  only `manual` counts as a human override.
- Both carry that provenance's time as `recorded_at`, and neither ever requires it. A
  producer that has no honest timestamp writes none rather than inventing one.

v1 -> v2 -> v3 is additive only: every field added in v2 and v3 is optional with an empty
default, so an older file parses as the current version with the new fields unset. There is
no migration pass — the first save of an older case writes a current file.
`tests/test_findings_schema.py` pins this.

pydantic + stdlib only — no WeasyPrint, no SimpleITK. Importable and testable on a bare host.
"""
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

SCHEMA_VERSION = 3

# Contrast phases in acquisition order. `tests/test_findings_schema.py` asserts that every
# contrast input in `Config.INPUTS` is one of them.
CONTRAST_PHASES = (
    "contrast_pre",
    "contrast_1",
    "contrast_2",
    "contrast_3",
    "contrast_4",
)

# The mask layers a finding can anchor to.
LAYER_IDS = ("layer1", "layer2", "layer3", "findings1")

# How many channels a layer offers. Must equal the frontend's MAX_CHANNEL; they drifted once,
# and every finding placed above the old cap came back 422.
#
# A product setting, not a storage one. The engine stores one byte per voxel whose value IS
# the label, so anything up to 255 is writable; what caps it lower is that colour separability
# runs out near twenty -- which is exactly where this now sits.
MIN_CHANNEL = 1
MAX_CHANNEL = 20


def _utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)


# A value stored in one of the two ACR lexicon maps.
#
# The maps hold the 41 fields whose only consumers are the form renderer and the PDF table.
# They are deliberately not named pydantic fields: `manualForm.ts` already holds those 41
# names, verified verbatim against the reference PDF, and restating them here would add a
# second place that can drift from the standard.
AcrValue = Union[str, float, bool]


class Lesion(BaseModel):
    """Which mask this finding describes."""

    layer_id: Literal["layer1", "layer2", "layer3", "findings1"]
    channel: int = Field(ge=MIN_CHANNEL, le=MAX_CHANNEL)
    # Mirrored from the layer/channel colour map for display only. Never authoritative —
    # if it disagrees with the viewer, the viewer wins.
    color: Optional[str] = None


class Curve(BaseModel):
    """One ROI sampled across the contrast phases.

    The three arrays are parallel and must be the same length. A case missing a phase
    simply omits it from all three — never padded, never interpolated.
    """

    phases: List[str] = Field(default_factory=list)
    mean_intensity: List[float] = Field(default_factory=list)
    percent_change: List[float] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self):
        if len(self.mean_intensity) != len(self.phases):
            raise ValueError("mean_intensity must be the same length as phases")
        if len(self.percent_change) != len(self.phases):
            raise ValueError("percent_change must be the same length as phases")

        unknown = [p for p in self.phases if p not in CONTRAST_PHASES]
        if unknown:
            raise ValueError(f"unknown contrast phases: {unknown}")

        order = [CONTRAST_PHASES.index(p) for p in self.phases]
        if order != sorted(order):
            raise ValueError("phases must be in acquisition order")
        if len(set(order)) != len(order):
            raise ValueError("phases must not repeat")

        if self.percent_change and self.percent_change[0] != 0:
            raise ValueError("percent_change[0] is relative to itself and must be 0")
        return self


class Kinetics(BaseModel):
    early_phase: Optional[Literal["slow", "medium", "fast"]] = None
    delayed_phase: Optional[Literal["persistent", "plateau", "washout"]] = None
    curve: Curve = Field(default_factory=Curve)
    # Where this curve came from, and it is printed:
    #   "mock"            — illustrative, produced by nothing real. The report prints a caveat.
    #   "provided"        — supplied in the input dataset, origin unstated.
    #   "model_predicted" — computed by the upstream prediction model.
    #   "computed"        — this app measured the ROI across the contrast volumes.
    # The default stays "mock" so a curve whose origin nobody recorded is treated as the
    # least trustworthy of the four, never as real data.
    source: Literal["mock", "provided", "model_predicted", "computed"] = "mock"


class Distance(BaseModel):
    """A distance in centimetres, with where the number came from.

    Three origins, and the report prints which:

    - `measured` — captured from the live DTS/DTN/DTR in this app.
    - `computed` — produced upstream, in the delivered `findings_json`, from the mask and
      anatomical landmarks.
    - `manual` — typed by the clinician, and the only value that means a human overrode a
      number.

    Only `manual` counts as a modification. Machine output, wherever it was produced, is not
    an override.

    `recorded_at` is never required. An upstream producer usually has no honest answer for
    when it computed a number — only when its pipeline ran, which is the same instant for
    every finding in the case and already implied by the dataset. Demanding it there would
    force a fabricated timestamp into a clinical record to satisfy a validator, which is the
    failure this schema avoids everywhere else by making "not assessed" expressible. The
    report prints the time when there is one and omits it when there is not.
    """

    value: float = Field(ge=0)
    source: Literal["measured", "computed", "manual"]
    recorded_at: Optional[datetime] = None

    @model_validator(mode="after")
    def _check(self):
        if self.source == "manual" and self.recorded_at is not None:
            raise ValueError("a manual distance must not carry recorded_at")
        return self


class Location(BaseModel):
    laterality: Optional[Literal["right", "left", "bilateral"]] = None
    # Clock face is the ACR's preferred notation; quadrant is the documented fallback.
    # Exactly one of the two, or neither.
    clock_position: Optional[int] = Field(default=None, ge=1, le=12)
    quadrant: Optional[
        Literal["UOQ", "UIQ", "LOQ", "LIQ", "retroareolar", "central", "axillary_tail"]
    ] = None
    depth: Optional[Literal["anterior", "middle", "posterior"]] = None

    distance_nipple_cm: Optional[Distance] = None
    distance_skin_cm: Optional[Distance] = None
    distance_ribcage_cm: Optional[Distance] = None

    @model_validator(mode="after")
    def _check(self):
        if self.clock_position is not None and self.quadrant is not None:
            raise ValueError("clock_position and quadrant are mutually exclusive")
        return self


class Measurement(BaseModel):
    """A number the app can produce, plus whether it did.

    Deliberately a twin of `Distance` rather than a reuse of it, and the two now share
    `computed` as a source — so the distinction is not the vocabulary, it is what a
    measurement can never do: be sphere-placed. `Distance` has `measured` because a
    clinician can place DTS/DTN/DTR spheres in this app and capture the result directly;
    there is no equivalent gesture for a size, so `Measurement` only ever arrives as
    `computed` (produced upstream or by this app scanning the mask) or `manual` (typed).
    Collapsing the two models onto one would erase the sphere-placement path that only
    `Distance` has.

    The timestamp is named `recorded_at` on both, because it answers the same question on
    both: when this number came into existence. Two names for one concept bought nothing and
    cost every reader of the delivery spec a paragraph explaining which was which.

    Never required — see `Distance.recorded_at` for why.
    """

    value: float = Field(ge=0)
    source: Literal["computed", "manual"]
    recorded_at: Optional[datetime] = None

    @model_validator(mode="after")
    def _check(self):
        if self.source == "manual" and self.recorded_at is not None:
            raise ValueError("a manual measurement must not carry recorded_at")
        return self


class Size(BaseModel):
    """Lesion extents, in millimetres, plus volume in cubic millimetres.

    `ap_mm` / `transverse_mm` / `craniocaudal_mm` are ANATOMICAL axes. They are only written
    when the volume's affine is close to axis-aligned in LPS; a bounding box measured along
    the image's own axes is not an anatomical extent once the image is rotated, and printing
    one as "AP 2.4 cm" in a clinical report would be a fabricated number. `max_linear_mm` and
    `volume_mm3` do not depend on that and are always available.
    """

    max_linear_mm: Optional[Measurement] = None
    ap_mm: Optional[Measurement] = None
    transverse_mm: Optional[Measurement] = None
    craniocaudal_mm: Optional[Measurement] = None
    volume_mm3: Optional[Measurement] = None


class Provenance(BaseModel):
    """What the clinician changed by hand.

    Only the mask side is stored. Whether a finding's FIELDS were overridden is derivable —
    a finding is field-modified iff any of its measurements or distances has
    `source == "manual"` — and storing it as well would create a second source of truth that
    can disagree with the first. See `field_modified()` below.

    `mask_edited` cannot be derived, because the app keeps no pristine baseline of the mask
    to diff against. It is set by an explicit signal from the drawing pipeline.

    `mask_ai_merged` is the same kind of claim about a different actor: the AI sandbox was
    folded into this finding's channel. It is deliberately NOT `mask_edited`, because a report
    that called an AI merge a hand edit would be claiming a clinician drew what a model
    produced. The two are independent, not exclusive — merging an AI mask and then correcting
    it by hand is two things that both happened, and each sets its own flag without clearing
    the other.

    Known limitation, documented in docs/: an edit made to a `{layer, channel}` before a
    finding was anchored there is not attributed to that finding.

    `last_edited_at` answers a different question from the two override claims: not *what* was
    replaced but *when the finding was last touched*. Most of a finding is lexicon selections —
    laterality, clock position, quadrant, depth, the kinetics phases, the category — which are
    manual by definition, carry no `source` to derive from, and so leave no other trace. It is
    stamped only by explicit clinician actions; automatic recomputation of measured sizes does
    not stamp it, or it would advance on every mask redraw and stop meaning anything.
    """

    mask_edited: bool = False
    mask_edited_at: Optional[datetime] = None
    mask_ai_merged: bool = False
    mask_ai_merged_at: Optional[datetime] = None
    last_edited_at: Optional[datetime] = None

    @model_validator(mode="after")
    def _check(self):
        if self.mask_edited and self.mask_edited_at is None:
            raise ValueError("an edited mask must carry mask_edited_at")
        if not self.mask_edited and self.mask_edited_at is not None:
            raise ValueError("mask_edited_at without mask_edited is meaningless")
        if self.mask_ai_merged and self.mask_ai_merged_at is None:
            raise ValueError("an AI-merged mask must carry mask_ai_merged_at")
        if not self.mask_ai_merged and self.mask_ai_merged_at is not None:
            raise ValueError("mask_ai_merged_at without mask_ai_merged is meaningless")
        return self


class Finding(BaseModel):
    id: str
    label: str
    lesion: Lesion
    kinetics: Kinetics = Field(default_factory=Kinetics)
    location: Location = Field(default_factory=Location)
    size: Size = Field(default_factory=Size)
    # Per-finding BI-RADS. Two things are derived from it and neither is stored: the band
    # this finding is filed under (`lexicon.group_of`) and the exam-level category in
    # `Assessment` (`lexicon.derive_exam_category`).
    #
    # An earlier version of this model carried a separate `triage` field that could
    # contradict this one. A document still holding it loads — pydantic drops unknown fields
    # — and the value is discarded rather than migrated, because it recorded a band that the
    # category may not support.
    assessment: Optional[int] = Field(default=None, ge=0, le=6)
    provenance: Provenance = Field(default_factory=Provenance)
    acr_lesion: Dict[str, AcrValue] = Field(default_factory=dict)


def field_modified(finding):
    """True when any computable value on this finding was overridden by hand.

    Derived rather than stored — see `Provenance`. Lexicon selections do not count: they have
    no machine-produced value to override, so every one of them is manual by definition and
    treating them as modifications would mark every finding.
    """
    size = finding.size
    for measurement in (
        size.max_linear_mm,
        size.ap_mm,
        size.transverse_mm,
        size.craniocaudal_mm,
        size.volume_mm3,
    ):
        if measurement is not None and measurement.source == "manual":
            return True

    location = finding.location
    for distance in (
        location.distance_nipple_cm,
        location.distance_skin_cm,
        location.distance_ribcage_cm,
    ):
        if distance is not None and distance.source == "manual":
            return True

    return False


class BreastTissue(BaseModel):
    """Case-level. Collected as labelled placeholders for now — see requirements.md."""

    fgt: Optional[
        Literal["almost_entirely_fatty", "scattered", "heterogeneous", "extreme"]
    ] = None
    bpe_level: Optional[Literal["minimal", "mild", "moderate", "marked"]] = None
    bpe_symmetry: Optional[Literal["symmetric", "asymmetric"]] = None


class Assessment(BaseModel):
    """One per case, matching the ACR form's exam-level "select one".

    When `source == "derived"` the stored `category` is a cache of
    `lexicon.derive_exam_category(findings)`, refreshed on every save. When
    `source == "manual"` the stored value is authoritative and per-finding edits leave it
    alone. Clearing the override means setting `source` back to `"derived"`; the next save
    recomputes.
    """

    category: Optional[int] = Field(default=None, ge=0, le=6)
    source: Literal["derived", "manual"] = "derived"
    # Which of the ACR form's two Category 0 rows was chosen. `category` alone cannot say:
    # "Need Additional Imaging Evaluation" and "Need Prior Imaging for Comparison" are both
    # 0, and collapsing them loses the clinician's actual answer in a clinical document.
    # Stored beside the integer rather than encoded into it, so `group_of()` and
    # `derive_exam_category()` keep reading one number and need no change.
    zero_reason: Optional[Literal["additional_imaging", "prior_comparison"]] = None


class ReadingSession(BaseModel):
    """When the timed reading of this case started and finished, and how far it got.

    Elapsed time is `finished_at - started_at` and is never stored. An accumulator would be
    a second truth that can disagree with the timestamps, and it cannot survive a browser
    being closed mid-session; the wall clock can.

    `visited_steps` holds step ids the clinician has moved past. Completion is that, not
    whether fields hold values: a patient with no implants correctly leaves all fourteen of
    section J empty, and an AI-prefilled section has values nobody has checked yet.
    """

    state: Literal["not_started", "in_progress", "finished"] = "not_started"
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    visited_steps: List[str] = Field(default_factory=list)
    current_step: Optional[str] = None
    # Set only when the clinician confirmed finishing with steps still unvisited. Stored
    # rather than derived, so the report can still say the reading was knowingly cut short
    # after later edits have changed the counts.
    finished_incomplete: bool = False


class Findings(BaseModel):
    schema_version: int = SCHEMA_VERSION
    updated_at: datetime = Field(default_factory=_utc_now)
    breast_tissue: BreastTissue = Field(default_factory=BreastTissue)
    findings: List[Finding] = Field(default_factory=list)
    assessment: Assessment = Field(default_factory=Assessment)
    acr_case: Dict[str, AcrValue] = Field(default_factory=dict)
    reading_session: ReadingSession = Field(default_factory=ReadingSession)

    @model_validator(mode="after")
    def _check(self):
        ids = [f.id for f in self.findings]
        if len(set(ids)) != len(ids):
            raise ValueError("finding ids must be unique")

        anchors = [(f.lesion.layer_id, f.lesion.channel) for f in self.findings]
        if len(set(anchors)) != len(anchors):
            raise ValueError("two findings cannot claim the same layer and channel")
        return self


# --- The seed for a case with no delivered reading -----------------------------


def empty_findings():
    """A `Findings` for a case whose reading record was not supplied.

    Deliberately empty rather than plausible. This replaced a mock that invented two lesions
    with laterality, clock positions, kinetics curves and BI-RADS categories — every one of
    them a clinical assertion, and all of them rendered into the report PDF. An empty record
    asserts nothing, which is the only honest thing to say about a case nobody has read.

    `Findings()` alone is already this document; the name exists so the call sites say why.
    """
    return Findings()


def dumps(findings):
    """Canonical on-disk JSON for a `Findings`."""
    return findings.model_dump_json(indent=2)


def loads(raw):
    """Parse on-disk JSON. Raises `pydantic.ValidationError` on anything malformed."""
    return Findings.model_validate_json(raw)
