"""The patient's report: the findings record, with sizes and slice images taken from one mask.

One cohort's three inputs make the whole report: the findings record, the contrast-1 volume and
the researcher-manual mask. The mask is the one the 3D view meshes, so the lesion the patient
sees, its printed size and its slice image can never disagree.

- Sizes are measured from the mask (`app.reports.sizes`) and replace the record's, except a size
  somebody typed (`source == "manual"`), which stays: the validator's rule.
- Location and assessment are printed as the record holds them; this app fills in neither.
- Each finding gets the axial slice through its centre of mass, over the contrast-1 volume, with
  its mask outlined in its colour, or the reason it has none. A finding never raises.
- The case is the cohort; there is no assay, reader or reading session to print.

Volumes are read in memory (`read_canonical`): nothing decompressed touches the disk. WeasyPrint
is imported only when a PDF is rendered, so the app still starts on a host that lacks it.
"""

import functools
import hashlib
import logging
import re
import time
from base64 import b64encode
from datetime import tzinfo
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple

from app.geometry import canonical
from app.reports import schema
from app.reports.render import render_report_html, render_report_pdf
from app.reports.sizes import anatomical_withheld, compute_sizes
from app.reports.slice_image import centroid_of, render_slice_png
from app.services.volume_reader import read_canonical

logger = logging.getLogger(__name__)

#: The series every slice image is drawn over: the one on screen in My MRI.
SERIES_LABEL = "Contrast phase 1"

#: Outline colour for a finding whose colour is missing or not `#rrggbb`. Neutral on purpose:
#: the outline colour is meant to be the finding's own, and grey says "unknown".
OUTLINE_FALLBACK = "#9e9e9e"
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

_SIZE_FIELDS = ("max_linear_mm", "ap_mm", "transverse_mm", "craniocaudal_mm", "volume_mm3")

#: The files whose content decides what a report looks like: the template, stylesheet, form
#: table and drawing code under app/reports, and this module.
_REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"
_VERSION_SUFFIXES = (".py", ".html", ".css", ".json")


class ReportUnavailable(Exception):
    """WeasyPrint, or a system library it loads, cannot be imported on this host."""


class ReportParts(NamedTuple):
    """Everything `render_report_*` takes besides the zone."""

    case: SimpleNamespace
    findings: schema.Findings
    anatomical_withheld: str
    lesion_images: dict


def version_sources() -> list[Path]:
    reports = [p for p in _REPORTS_DIR.iterdir() if p.is_file() and p.suffix in _VERSION_SUFFIXES]
    return sorted(reports) + [Path(__file__).resolve()]


@functools.cache
def report_version() -> str:
    """A digest of the report's own sources, for the PDF cache key.

    Derived rather than bumped by hand, so a changed template or stylesheet can never be
    answered with a PDF cached from the old one.
    """
    digest = hashlib.sha1()
    for path in version_sources():
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def _require_weasyprint() -> None:
    try:
        import weasyprint  # noqa: F401
    except (ImportError, OSError) as e:
        # OSError: the package is installed but Pango/GObject are not, as on Windows.
        raise ReportUnavailable(f"WeasyPrint cannot be loaded: {e}") from e


def weasyprint_available() -> bool:
    try:
        _require_weasyprint()
    except ReportUnavailable:
        return False
    return True


def _outline_color(color) -> str:
    return color if isinstance(color, str) and _HEX_COLOR.match(color) else OUTLINE_FALLBACK


def lesion_images(findings, series, mask) -> dict[str, dict]:
    """One slice image per finding, `{"uri", "caption"}`, or `{"reason"}` when there is none.

    `series` and `mask` are `read_canonical` results, `(voxels, geometry)`, or None when their
    bytes could not be read. The slice is the axial plane through the channel's centre of mass,
    numbered as the viewer numbers it. A mask that is not on the series' grid is refused, never
    drawn: an outline in the wrong place is worse than none.
    """
    if mask is None:
        return {f.id: {"reason": "the mask could not be read"} for f in findings}
    if series is None:
        return {f.id: {"reason": "the background series could not be read"} for f in findings}

    mask_voxels, mask_grid = mask
    volume, series_grid = series
    mismatches = canonical.same_grid(series_grid, mask_grid)
    if mismatches:
        # The numbers go to the log; the page names only what differs.
        logger.warning("the mask is not on the contrast-1 grid: %s", canonical.describe_mismatches(mismatches))
        fields = [m.field for m in mismatches]
        verb = "differs" if len(fields) == 1 else "differ"
        reason = f"the mask and the image are not on the same grid (their {' and '.join(fields)} {verb})"
        return {f.id: {"reason": reason} for f in findings}

    labels = canonical.view_labels("z", series_grid)
    images = {}
    for finding in findings:
        channel = finding.lesion.channel
        centre = centroid_of(mask_voxels, channel)
        if centre is None:
            images[finding.id] = {"reason": "this finding has not been segmented"}
            continue
        z = centre[2]
        try:
            png = render_slice_png(volume, mask_voxels, channel, z, _outline_color(finding.lesion.color), labels=labels)
        except canonical.GeometryMismatch as e:
            logger.warning("no slice image for %s: %s", finding.id, e.detail)
            images[finding.id] = {"reason": e.summary}
            continue
        images[finding.id] = {
            "uri": "data:image/png;base64," + b64encode(png).decode("ascii"),
            "caption": f"{SERIES_LABEL} - axial slice {z}",
        }
    return images


def _with_computed(recorded: schema.Size, computed: schema.Size) -> schema.Size:
    values = {}
    for field in _SIZE_FIELDS:
        kept = getattr(recorded, field)
        values[field] = kept if kept is not None and kept.source == "manual" else getattr(computed, field)
    return schema.Size(**values)


def prepare_report(cohort: str, findings: schema.Findings, volume_bytes: bytes | None,
                   mask_bytes: bytes | None) -> ReportParts:
    """The report's case, its findings with measured sizes, and one slice image per finding.

    `findings` is not modified. Unreadable bytes never raise: an unreadable mask leaves every
    size empty and every finding a reason, an unreadable volume costs only the images.
    """
    mask = read_canonical(mask_bytes, "researcher_manual_LPS_nii.nii.gz")
    # The volume only feeds the slice images, which need the mask too.
    series = read_canonical(volume_bytes, "contrast_1_nrrd.nrrd") if mask is not None else None

    record = findings.model_copy(deep=True)
    sizes = compute_sizes(mask[0], mask[1], [f.lesion.channel for f in record.findings]) if mask is not None else {}
    for finding in record.findings:
        finding.size = _with_computed(finding.size, sizes.get(finding.lesion.channel, schema.Size()))

    return ReportParts(
        case=SimpleNamespace(name=cohort, id=cohort, assay_uuid=None, user_uuid=None),
        findings=record,
        anatomical_withheld=anatomical_withheld(mask[1]) if mask is not None else "",
        lesion_images=lesion_images(record.findings, series, mask),
    )


def build_report_html(cohort: str, findings: schema.Findings, volume_bytes: bytes | None,
                      mask_bytes: bytes | None, zone: tzinfo) -> str:
    """The report as HTML: what the PDF renders, and testable without WeasyPrint."""
    parts = prepare_report(cohort, findings, volume_bytes, mask_bytes)
    return render_report_html(parts.case, parts.findings, parts.anatomical_withheld, parts.lesion_images, zone)


def build_report_pdf(cohort: str, findings: schema.Findings, volume_bytes: bytes | None,
                     mask_bytes: bytes | None, zone: tzinfo) -> bytes:
    """The report as PDF bytes. Raises ReportUnavailable, before reading any volume, when
    WeasyPrint cannot be loaded."""
    _require_weasyprint()
    started = time.perf_counter()
    parts = prepare_report(cohort, findings, volume_bytes, mask_bytes)
    pdf = render_report_pdf(parts.case, parts.findings, parts.anatomical_withheld, parts.lesion_images, zone)
    logger.info("rendered the report of %s in %.1f s (%d bytes)", cohort, time.perf_counter() - started, len(pdf))
    return pdf
