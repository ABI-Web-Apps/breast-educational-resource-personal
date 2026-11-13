"""ACR BI-RADS(R) MRI lexicon — the option values, their human labels, and the
definition text printed under each value in the report.

Ported unchanged from the validator, which transcribed it from the ACR BI-RADS v2025
Manual, Appendix A — MRI Lexicon Summary Form:

    p. 717  Breast tissue — FGT, BPE level, BPE symmetry
    p. 718  Enhancement kinetics — early phase, delayed phase
    p. 719  Location of finding — laterality, location in breast, depth, distances
    p. 721  Assessment categories — management and likelihood of cancer

Masses, NME, lymph nodes, associated features and implants are not here; the report prints
them from the ACR form table (`acr_form.py`).

Plain stdlib: importable from renderers and tests alike.
"""

# --- Breast tissue (p. 717) — collected as placeholders only for now -----------

FGT = {
    "almost_entirely_fatty": ("Almost entirely fatty", ""),
    "scattered": ("Scattered fibroglandular tissue", ""),
    "heterogeneous": ("Heterogeneous fibroglandular tissue", ""),
    "extreme": ("Extreme fibroglandular tissue", ""),
}

BPE_LEVEL = {
    "minimal": ("Minimal", "Includes no enhancement"),
    "mild": ("Mild", ""),
    "moderate": ("Moderate", ""),
    "marked": ("Marked", ""),
}

BPE_SYMMETRY = {
    "symmetric": ("Symmetric", ""),
    "asymmetric": ("Asymmetric", ""),
}

BPE_NOTE = (
    "Primarily assessed on the first post-contrast image; subtraction and MIP "
    "imaging may give additional information"
)

# --- Enhancement kinetics (p. 718) --------------------------------------------

EARLY_PHASE_NOTE = (
    "Enhancement-related signal intensity within the first 60-120 seconds after "
    "contrast injection"
)

EARLY_PHASE = {
    "slow": ("Slow", "< 50% increase in signal intensity"),
    "medium": ("Medium", "50-100% increase in signal intensity"),
    "fast": ("Fast", "> 100% increase in signal intensity"),
}

DELAYED_PHASE_NOTE = (
    "Enhancement-related signal intensity after the first 60-120 seconds after "
    "contrast injection or when the curve begins to change"
)

DELAYED_PHASE = {
    "persistent": ("Persistent", "Signal intensity increases > 10% compared to early phase"),
    "plateau": ("Plateau", "Signal intensity increases or decreases <= 10% compared to early phase"),
    "washout": ("Washout", "Signal intensity decreases > 10% compared to early phase"),
}

# --- Location of finding (p. 719) ---------------------------------------------

LATERALITY = {
    "right": ("Right", ""),
    "left": ("Left", ""),
    "bilateral": ("Bilateral", ""),
}

QUADRANT = {
    "UOQ": ("Upper outer quadrant", ""),
    "UIQ": ("Upper inner quadrant", ""),
    "LOQ": ("Lower outer quadrant", ""),
    "LIQ": ("Lower inner quadrant", ""),
    "retroareolar": ("Retroareolar", ""),
    "central": ("Central", ""),
    "axillary_tail": ("Axillary tail", ""),
}

DEPTH = {
    "anterior": ("Anterior third", ""),
    "middle": ("Middle third", ""),
    "posterior": ("Posterior third", ""),
}

DISTANCE_NOTE = (
    "From base of nipple to centre of finding in whole cm; include centimetres from "
    "the skin, or chest wall as appropriate"
)

# --- Assessment categories (p. 721) -------------------------------------------
# category -> (title, management, likelihood of cancer)

ASSESSMENT_CATEGORY = {
    0: (
        "Incomplete: Need Additional Imaging Evaluation or Prior Imaging for Comparison",
        "Recall for additional imaging; need comparison to prior examination(s)",
        "N/A",
    ),
    1: (
        "Negative",
        "Routine breast screening, including MRI if appropriate according to major guidelines",
        "Essentially 0% likelihood of malignancy",
    ),
    2: (
        "Benign",
        "Routine breast screening, including MRI if appropriate according to major guidelines",
        "Essentially 0% likelihood of malignancy",
    ),
    3: (
        "Probably Benign",
        "Short-interval (6-month) follow-up or continued surveillance (12-month)",
        ">= 0% but <= 2% likelihood of malignancy",
    ),
    4: (
        "Suspicious",
        "Tissue diagnosis",
        "> 2% but < 95% likelihood of malignancy",
    ),
    5: (
        "Highly Suggestive of Malignancy",
        "Tissue diagnosis",
        ">= 95% likelihood of malignancy",
    ),
    6: (
        "Known Biopsy-Proven Malignancy",
        "Clinical follow-up with surgeon and/or oncologist, and definitive local therapy "
        "(usually surgery) when clinically appropriate",
        "N/A",
    ),
}

# --- Accessors ----------------------------------------------------------------
# Every value is nullable in findings_json: null means "not assessed" and must render
# as an explicit placeholder, never as an empty string that reads like a bug.

NOT_ASSESSED = "Not assessed"


def label(table, value):
    """Human label for a lexicon value, or the not-assessed placeholder."""
    if value is None:
        return NOT_ASSESSED
    entry = table.get(value)
    return entry[0] if entry else str(value)


def definition(table, value):
    """ACR definition text for a lexicon value. Empty when the standard gives none."""
    if value is None:
        return ""
    entry = table.get(value)
    return entry[1] if entry else ""


def category_title(category):
    entry = ASSESSMENT_CATEGORY.get(category)
    return entry[0] if entry else NOT_ASSESSED


def category_management(category):
    entry = ASSESSMENT_CATEGORY.get(category)
    return entry[1] if entry else ""


def category_likelihood(category):
    entry = ASSESSMENT_CATEGORY.get(category)
    return entry[2] if entry else ""


# --- Finding groups -----------------------------------------------------------
# The band a finding is sorted into during a read. Not part of the ACR lexicon — an app
# concept, kept here so it lives beside the categories it is derived from.
#
# The band is ALWAYS derived and never stored. An earlier design had it as an independent
# field that could contradict the category; this replaces that. Because it is a function of
# the category, a contradiction is not representable, and nothing needs to detect one.
#
# `GROUP_ORDER` is severity-descending: a reader opens a report for the worst thing in it.

GROUP_ORDER = ("malignant", "suspicious", "benign", "unassessed")

GROUP_LABELS = {
    "malignant": "Malignant",
    "suspicious": "Suspicious",
    "benign": "Benign",
    "unassessed": "Unassessed",
}

# BI-RADS 0 shares a band with "nobody has assessed this yet". The two mean different things
# clinically — 0 is "I cannot assess this without more imaging" — and folding them together
# would normally lose that. It does not here: the badge on the chip and on the report card
# still prints 0 rather than an em-dash. The band answers "what do I do with this list", and
# for that question both are the same answer.
#
# NOTE: this does NOT change what 0 means to the EXAM. `derive_exam_category` below still
# makes the whole examination incomplete when any finding is 0. A finding being unsorted in a
# worklist and an examination being unfinalisable are two different consequences of the same
# number; do not propagate this grouping into that rule.
GROUP_BY_CATEGORY = {
    0: "unassessed",
    1: "benign",
    2: "benign",
    3: "suspicious",
    4: "suspicious",
    5: "malignant",
    6: "malignant",
}


def group_of(assessment):
    """The band a finding sits in, from its BI-RADS category.

    `None` — not assessed — groups with 0. An unknown category also groups as unassessed
    rather than raising: the schema already bounds the field to 0..6, so reaching here with
    anything else means a hand-edited file, and a report that renders it in a visible
    "unassessed" band is more use than one that fails to render at all.
    """
    return GROUP_BY_CATEGORY.get(assessment, "unassessed")


def group_label(group):
    return GROUP_LABELS.get(group, GROUP_LABELS["unassessed"])


# --- Deriving the exam-level assessment ---------------------------------------

# BI-RADS categories are NOT ranked by their number. 0 means the exam is incomplete and 6
# means biopsy-proven malignancy, so max() would rank an incomplete exam below a benign one
# and a known cancer above everything including an exam that cannot yet be read. The order
# below is severity for the purpose of summarising a set of findings into one exam-level
# category; index 0 is least severe.
#
# This is a clinical rule, owned by the validator. It is isolated in this one function
# precisely so changing it is a one-line change with a boundary table behind it.
CATEGORY_SEVERITY = (1, 2, 3, 4, 5, 6)

INCOMPLETE_CATEGORY = 0

DERIVED_NOTE = (
    "Derived from the individual findings: an incomplete finding makes the exam "
    "incomplete, otherwise the exam takes the most severe finding."
)


def derive_exam_category(findings):
    """The exam-level BI-RADS category implied by a list of findings.

    Rules, in order:

    1. Any finding assessed 0 makes the exam 0. An incomplete exam cannot be finalised
       regardless of what else is on it, so this outranks everything rather than losing to
       a higher number.
    2. Otherwise the exam takes the most severe of the remaining categories, by
       `CATEGORY_SEVERITY`.
    3. No finding carries a category -> `None`, which renders as "not assessed" rather than
       as a default that reads like a real assessment.

    Takes anything iterable whose items have an `assessment` attribute, so it works on both
    `Finding` models and plain stand-ins in tests.
    """
    categories = [
        f.assessment for f in findings if getattr(f, "assessment", None) is not None
    ]
    if not categories:
        return None
    if INCOMPLETE_CATEGORY in categories:
        return INCOMPLETE_CATEGORY

    ranked = [c for c in categories if c in CATEGORY_SEVERITY]
    if not ranked:
        return None
    return max(ranked, key=CATEGORY_SEVERITY.index)


def resolve_exam_category(assessment, findings):
    """The category to display and print, honouring a manual override.

    `source == "manual"` means the clinician set it and per-finding edits must not move it.
    Anything else recomputes from the findings.
    """
    if getattr(assessment, "source", "derived") == "manual":
        return assessment.category
    return derive_exam_category(findings)
