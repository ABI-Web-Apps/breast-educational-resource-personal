"""Turn a case plus its findings into the flat context the report template renders.

Kept separate from `render.py` so everything except the WeasyPrint call is pure and
testable on a bare host: no template engine, no PDF library, no database session — a `Case`
is only ever read for four attributes, so tests pass a stub.

Every value that reaches the template is already a display string. The template does no
formatting and no lookups; if a number needs a unit or a null needs a placeholder, it
happens here.
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.reports import lexicon, schema
from app.reports.acr_form import ACR_SECTIONS, render_value
from app.reports.svg import clock_svg, kinetics_svg

EM_DASH = "—"

# Which mask each lesion was measured on. Clinically load-bearing: a size taken from the
# model's prediction is not the same claim as one taken from the clinician's own mask. Every
# size and slice image in this report comes from one mask, the Clinician Layer
# (researcher_manual_LPS_nii), whichever layer the record anchors a finding to, so every card
# names that mask rather than the record's layer.
MASK_LABEL = "Clinician layer"

# Drives the assessment hero's colour. Benign runs cool, malignant runs warm.
CATEGORY_TONE = {
    0: "tone-neutral",
    1: "tone-benign",
    2: "tone-benign",
    3: "tone-watch",
    4: "tone-suspicious",
    5: "tone-malignant",
    6: "tone-known",
}

PRODUCT = "Breast Educational Resource"

DISCLAIMER = "Research use. Not for primary diagnostic interpretation."


def _acr_rows(section, values):
    """One section's rows, INCLUDING unfilled ones -- the report prints the whole form.

    Bound fields are skipped: they are rendered by their own named sections, and printing a
    value twice leaves a reader unable to tell which is authoritative.
    """
    return {
        "id": section.id,
        "title": section.title,
        "rows": [
            {"id": f.id, "label": f.label, "text": render_value(f.id, values.get(f.id))}
            for f in section.fields
            if f.bind is None
        ],
    }


def resolve_zone(name):
    """The zone to print a report in: the reader's, named as an IANA key, else UTC.

    The browser sends its own zone with each request for the report, so the PDF reads in the
    same zone as the panel. No name, or one that is not a zone, gives UTC, which every time in
    the report then says it is in. Never an error: a bad zone must not cost the report.
    """
    if not name:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError, OSError):
        # ZoneInfoNotFoundError is a KeyError; a malformed key is a ValueError.
        return timezone.utc


def _format_stamp(value, zone):
    """A moment as "23 Oct 2026, 10:51 NZDT": its date, its time and its zone.

    Each value converts on its own date, so a stamp from before a daylight-saving change
    carries that day's offset. A naive value is read as UTC, which is how the record stores
    every time.
    """
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(zone).strftime("%d %b %Y, %H:%M %Z")


def _format_datetime(value, zone):
    return _format_stamp(value, zone) if value is not None else EM_DASH


def _row(label, table, value, note=""):
    """One label/value row, with the ACR definition as its caption."""
    return {
        "label": label,
        "value": lexicon.label(table, value),
        "definition": lexicon.definition(table, value),
        "assessed": value is not None,
        "note": note,
    }


def _distance_row(label, distance, zone):
    """A distance with its provenance made visible.

    A measurement captured from the live tool and a number somebody typed are different
    kinds of claim, and a reader of the PDF cannot tell them apart unless the report says so.
    An absent distance prints an em dash, like the rest of the location (`_location_rows`).
    """
    if distance is None:
        return {
            "label": label,
            "value": EM_DASH,
            "source": "",
            "assessed": False,
        }
    captured = _format_stamp(distance.recorded_at, zone)
    # Print the origin the record actually claims. Collapsing anything that is not
    # "measured" onto "entered" would assert a human typed a number a machine produced,
    # in a clinical document.
    source = "entered" if distance.source == "manual" else distance.source
    if captured:
        source = f"{source} {captured}"
    return {
        "label": label,
        "value": f"{distance.value:.1f} cm",
        "source": source,
        "assessed": True,
    }


def _measurement_row(label, measurement, unit, zone, withheld_reason=""):
    """A size with its provenance made visible, or the reason it is absent.

    Three outcomes, and the reader has to be able to tell them apart: a number the app
    measured, a number somebody typed, and a field deliberately withheld because the image
    is not aligned to the patient axes. Printing a withheld field as "not assessed" would
    read as an omission rather than a refusal.
    """
    if withheld_reason:
        return {
            "label": label,
            "value": lexicon.NOT_ASSESSED,
            "source": "withheld",
            "assessed": False,
            "withheld": True,
        }
    if measurement is None:
        return {
            "label": label,
            "value": lexicon.NOT_ASSESSED,
            "source": "",
            "assessed": False,
            "withheld": False,
        }

    computed = _format_stamp(measurement.recorded_at, zone)
    source = "measured" if measurement.source == "computed" else "entered"
    if computed:
        source = f"{source} {computed}"
    return {
        "label": label,
        "value": f"{measurement.value:,.1f} {unit}",
        "source": source,
        "assessed": True,
        "withheld": False,
    }


def _size_rows(size, zone, anatomical_withheld=""):
    """The five size fields, in the order the panel shows them.

    `anatomical_withheld` carries the reason the three anatomical axes are unavailable; it
    only ever applies to those three, because volume and maximum linear dimension do not
    depend on the image's orientation.
    """
    return [
        _measurement_row("Maximum linear dimension", size.max_linear_mm, "mm", zone),
        _measurement_row("Anteroposterior", size.ap_mm, "mm", zone, anatomical_withheld),
        _measurement_row("Transverse", size.transverse_mm, "mm", zone, anatomical_withheld),
        _measurement_row("Craniocaudal", size.craniocaudal_mm, "mm", zone, anatomical_withheld),
        _measurement_row("Volume", size.volume_mm3, "mm³", zone),
    ]


def _provenance_tags(finding, zone):
    """How this finding's mask and numbers came to be, as printable tags.

    Three distinct claims, never merged: the voxels came from the AI sandbox, the voxels were
    drawn or erased by hand, a computed number was replaced by a typed one. A finding can
    carry any combination — merging an AI mask and then correcting it is two events, and
    collapsing them would tell a reader a clinician drew what a model produced.

    Ordered as the work happens: a merge lands first, corrections come after.
    """
    tags = []
    if finding.provenance.mask_ai_merged:
        at = _format_stamp(finding.provenance.mask_ai_merged_at, zone)
        tags.append(f"Mask merged from AI{f' at {at}' if at else ''}")
    if finding.provenance.mask_edited:
        at = _format_stamp(finding.provenance.mask_edited_at, zone)
        tags.append(f"Mask edited by hand{f' at {at}' if at else ''}")
    if schema.field_modified(finding):
        tags.append("Measurement overridden by hand")
    return tags


def _location_rows(location):
    """Laterality, position and depth. An unset one prints an em dash, not "Not assessed":
    this app records no location at all, and "Not assessed" would read as a step a clinician
    skipped."""
    rows = [_row("Laterality", lexicon.LATERALITY, location.laterality)]

    if location.clock_position is not None:
        position = f"{location.clock_position} o'clock"
        assessed = True
    elif location.quadrant is not None:
        position = lexicon.label(lexicon.QUADRANT, location.quadrant)
        assessed = True
    else:
        position = EM_DASH
        assessed = False
    rows.append(
        {
            "label": "Location in breast",
            "value": position,
            "definition": "",
            "assessed": assessed,
            "note": "",
        }
    )

    rows.append(_row("Depth", lexicon.DEPTH, location.depth))
    for row in rows:
        if not row["assessed"]:
            row["value"] = EM_DASH
    return rows


def _finding_context(finding, zone, anatomical_withheld=""):
    kinetics = finding.kinetics
    location = finding.location
    category = finding.assessment
    group = lexicon.group_of(category)

    return {
        "id": finding.id,
        "label": finding.label,
        "layer": MASK_LABEL,
        "channel": finding.lesion.channel,
        "color": finding.lesion.color or "#94a3b8",
        # --- Findings: size, then location. The client's order, matching the panel. ---
        "size_rows": _size_rows(finding.size, zone, anatomical_withheld),
        "size_withheld_note": anatomical_withheld,
        "clock_svg": clock_svg(location.clock_position, location.laterality),
        "location_rows": _location_rows(location),
        "distance_rows": [
            _distance_row("From nipple", location.distance_nipple_cm, zone),
            _distance_row("From skin", location.distance_skin_cm, zone),
            _distance_row("From ribcage", location.distance_ribcage_cm, zone),
        ],
        # --- Assessment ---
        # The band, derived. Printed on the card as well as used to group the cards, so a
        # reader who lands mid-document knows what list this finding is in without scrolling
        # back to the heading.
        "group": group,
        "group_label": lexicon.group_label(group),
        "assessment": {
            "assessed": category is not None,
            "category": EM_DASH if category is None else str(category),
            "title": lexicon.category_title(category),
            "management": lexicon.category_management(category) or EM_DASH,
            "likelihood": lexicon.category_likelihood(category) or EM_DASH,
            "tone": CATEGORY_TONE.get(category, "tone-neutral"),
        },
        "provenance_tags": _provenance_tags(finding, zone),
        # --- Enhancement kinetics, last ---
        "curve_svg": kinetics_svg(
            kinetics.curve, kinetics.early_phase, kinetics.delayed_phase
        ),
        # "provided", "model_predicted" and "computed" are all real data; only "mock" earns
        # the caveat.
        "curve_is_mock": kinetics.source == "mock",
        "kinetics_rows": [
            _row(
                "Early phase",
                lexicon.EARLY_PHASE,
                kinetics.early_phase,
                lexicon.EARLY_PHASE_NOTE,
            ),
            _row(
                "Delayed phase",
                lexicon.DELAYED_PHASE,
                kinetics.delayed_phase,
                lexicon.DELAYED_PHASE_NOTE,
            ),
        ],
    }


def _finding_groups(findings, zone, anatomical_withheld=""):
    """Findings grouped by band, most severe first.

    The band is derived from each finding's BI-RADS by `lexicon.group_of`, so this partition
    cannot disagree with the badge printed on the card. An empty band is dropped rather than
    printed empty — a heading over nothing reads as a rendering fault.
    """
    groups = []
    for key in lexicon.GROUP_ORDER:
        members = [f for f in findings if lexicon.group_of(f.assessment) == key]
        if not members:
            continue
        groups.append(
            {
                "key": key,
                "title": f"{lexicon.group_label(key)} findings",
                "count": len(members),
                "findings": [_finding_context(f, zone, anatomical_withheld) for f in members],
            }
        )
    return groups


def build_context(case, findings, anatomical_withheld="", zone=timezone.utc):
    """The full render context. `case` needs only `name`, `id`, `assay_uuid`, `user_uuid`.

    `anatomical_withheld`, when set, is the reason the AP / transverse / craniocaudal fields
    carry no value on this case. It is threaded through to every finding rather than checked
    per finding because it is a property of the image, not of any lesion.

    `zone` is the zone every time is printed in (`resolve_zone`); each time names it.

    There is no reading session here: this app times no reading, so a record's
    `reading_session` is never printed, whatever it holds.
    """
    # Honours a manual override; recomputes from the findings otherwise. Reading
    # `assessment.category` directly would print a stale cache if the file predates the last
    # per-finding edit.
    category = lexicon.resolve_exam_category(findings.assessment, findings.findings)
    derived = findings.assessment.source != "manual"

    context = {
        "product": PRODUCT,
        "document_title": "BI-RADS® MRI Structured Report",
        "disclaimer": DISCLAIMER,
        "case_name": getattr(case, "name", None) or EM_DASH,
        "meta": [
            {"label": "Case ID", "value": str(getattr(case, "id", "") or EM_DASH)},
            {"label": "Assay", "value": getattr(case, "assay_uuid", None) or EM_DASH},
            {"label": "Generated", "value": _format_datetime(datetime.now(timezone.utc), zone)},
            # The backend has no auth, so this is an identifier, not a verified identity.
            {"label": "Reader", "value": getattr(case, "user_uuid", None) or EM_DASH},
        ],
        "assessment": {
            "assessed": category is not None,
            "category": EM_DASH if category is None else str(category),
            "title": lexicon.category_title(category),
            "management": lexicon.category_management(category) or EM_DASH,
            "likelihood": lexicon.category_likelihood(category) or EM_DASH,
            "tone": CATEGORY_TONE.get(category, "tone-neutral"),
            # A derived category and one a clinician chose are different claims; the report
            # says which it is rather than presenting both as the reader's own conclusion.
            "source": "Derived from the individual findings" if derived else "Set by the reader",
            "derived": derived,
            "rule": lexicon.DERIVED_NOTE if derived else "",
        },
        "breast_tissue": {
            "note": lexicon.BPE_NOTE,
            "rows": [
                _row("Fibroglandular tissue", lexicon.FGT, findings.breast_tissue.fgt),
                _row(
                    "Background parenchymal enhancement",
                    lexicon.BPE_LEVEL,
                    findings.breast_tissue.bpe_level,
                ),
                _row("BPE symmetry", lexicon.BPE_SYMMETRY, findings.breast_tissue.bpe_symmetry),
            ],
        },
        # Grouped by band. `findings` is kept flat alongside it so a template that wants a
        # simple count or an "any findings at all" test does not have to flatten.
        "finding_groups": _finding_groups(findings.findings, zone, anatomical_withheld),
        "findings": [
            _finding_context(f, zone, anatomical_withheld) for f in findings.findings
        ],
        "distance_note": lexicon.DISTANCE_NOTE,
        "size_note": (
            "Sizes are computed from the mask; any value may be overridden by hand. "
            "The source of each is printed beneath it."
        ),
        "updated_at": _format_datetime(findings.updated_at, zone),
        "acr": {
            "case": [_acr_rows(s, findings.acr_case) for s in ACR_SECTIONS if s.scope == "case" and any(f.bind is None for f in s.fields)],
            "lesions": {
                f.id: [_acr_rows(s, f.acr_lesion) for s in ACR_SECTIONS if s.scope == "lesion" and any(f_field.bind is None for f_field in s.fields)]
                for f in findings.findings
            },
        },
    }
    return context
