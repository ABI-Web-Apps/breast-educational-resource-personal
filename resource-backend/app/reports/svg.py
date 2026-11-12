"""Vector graphics for the report — the kinetics curve and the breast clock.

Both are emitted as inline SVG. WeasyPrint rasterises nothing here, so a reader can zoom
the PDF to any magnification and the curve stays crisp, and the text inside it stays
selectable and searchable.

The curve's geometry comes from `kinetics.curve_geometry`, ported unchanged from the
validator, whose on-screen chart uses the same function, so this report draws the same curve
the validator's report and panel draw.

Colours are a print palette on white. Class colours run cool to warm as the finding gets
more concerning, which is why washout and fast share a hue.

Plain stdlib.
"""
from html import escape

from app.reports.kinetics import curve_geometry, polyline

# Class colours. Cool = reassuring, warm = concerning.
EARLY_COLORS = {
    "slow": "#0f766e",
    "medium": "#b45309",
    "fast": "#be123c",
}
DELAYED_COLORS = {
    "persistent": "#1d4ed8",
    "plateau": "#7c3aed",
    "washout": "#be123c",
}
UNKNOWN_COLOR = "#64748b"

AXIS = "#94a3b8"
GRID = "#e2e8f0"
INK = "#334155"
BAND_FILL = "#e0e7ff"

# Short axis labels for the contrast phases.
PHASE_LABELS = {
    "contrast_pre": "pre",
    "contrast_1": "1",
    "contrast_2": "2",
    "contrast_3": "3",
    "contrast_4": "4",
}


def _phase_label(name):
    return PHASE_LABELS.get(name, name.replace("contrast_", ""))


def kinetics_svg(curve, early_phase=None, delayed_phase=None, width=300, height=186):
    """Inline SVG for one lesion's enhancement kinetics.

    `curve` is a `schema.Curve`. `early_phase` / `delayed_phase` are the clinician's
    selections, which drive the segment colours — the report shows what was recorded, not
    what the curve suggests.
    """
    percent_change = list(curve.percent_change or [])
    phases = list(curve.phases or [])

    # Left padding has to clear the rotated axis caption *and* the widest tick label
    # ("100%"), or the "0" at the baseline collides with the caption.
    geo = curve_geometry(percent_change, width=width, height=height, padding=(14, 12, 26, 48))
    plot = geo["plot"]

    if geo["pending"]:
        return (
            f'<svg class="curve" viewBox="0 0 {width} {height}" width="{width}" '
            f'height="{height}" xmlns="http://www.w3.org/2000/svg" role="img">'
            f'<rect x="{plot["x"]:.1f}" y="{plot["y"]:.1f}" width="{plot["w"]:.1f}" '
            f'height="{plot["h"]:.1f}" fill="#f8fafc" stroke="{GRID}" '
            f'stroke-dasharray="3 3"/>'
            f'<text x="{width / 2:.1f}" y="{height / 2:.1f}" text-anchor="middle" '
            f'font-size="9" fill="{UNKNOWN_COLOR}">Awaiting segmentation</text>'
            f"</svg>"
        )

    early_color = EARLY_COLORS.get(early_phase, UNKNOWN_COLOR)
    delayed_color = DELAYED_COLORS.get(delayed_phase, UNKNOWN_COLOR)

    parts = [
        f'<svg class="curve" viewBox="0 0 {width} {height}" width="{width}" '
        f'height="{height}" xmlns="http://www.w3.org/2000/svg" role="img">',
        f'<rect x="{plot["x"]:.1f}" y="{plot["y"]:.1f}" width="{plot["w"]:.1f}" '
        f'height="{plot["h"]:.1f}" fill="#fbfdff"/>',
    ]

    # The +/-10% delayed band, drawn first so the curve sits on top of it.
    band = geo.get("band")
    if band:
        top = min(band["upper"], band["lower"])
        height_ = abs(band["lower"] - band["upper"])
        parts.append(
            f'<rect x="{plot["x"]:.1f}" y="{top:.1f}" width="{plot["w"]:.1f}" '
            f'height="{height_:.1f}" fill="{BAND_FILL}" opacity="0.38"/>'
        )
        # Edges, so the band reads as a threshold rather than as a shaded region.
        for edge in (top, top + height_):
            parts.append(
                f'<line x1="{plot["x"]:.1f}" y1="{edge:.1f}" '
                f'x2="{plot["x"] + plot["w"]:.1f}" y2="{edge:.1f}" '
                f'stroke="#c7d2fe" stroke-width="0.6" stroke-dasharray="2 2"/>'
            )

    # Early-phase thresholds.
    for guide in geo["guides"]:
        parts.append(
            f'<line x1="{plot["x"]:.1f}" y1="{guide["y"]:.1f}" '
            f'x2="{plot["x"] + plot["w"]:.1f}" y2="{guide["y"]:.1f}" '
            f'stroke="{GRID}" stroke-width="0.8" stroke-dasharray="3 2"/>'
        )
        parts.append(
            f'<text x="{plot["x"] - 4:.1f}" y="{guide["y"] + 2.5:.1f}" text-anchor="end" '
            f'font-size="6.5" fill="{AXIS}">{escape(guide["label"])}</text>'
        )

    # Baseline.
    parts.append(
        f'<line x1="{plot["x"]:.1f}" y1="{geo["baseline_y"]:.1f}" '
        f'x2="{plot["x"] + plot["w"]:.1f}" y2="{geo["baseline_y"]:.1f}" '
        f'stroke="{AXIS}" stroke-width="0.8"/>'
    )
    parts.append(
        f'<text x="{plot["x"] - 4:.1f}" y="{geo["baseline_y"] + 2.5:.1f}" '
        f'text-anchor="end" font-size="6.5" fill="{AXIS}">0</text>'
    )

    # The two coloured runs. They share the first post-contrast point, so the join is
    # continuous and the colour change lands exactly where the ACR rule changes.
    parts.append(
        f'<polyline points="{polyline(geo["early_segment"])}" fill="none" '
        f'stroke="{early_color}" stroke-width="2.2" stroke-linecap="round" '
        f'stroke-linejoin="round"/>'
    )
    if geo["delayed_segment"]:
        parts.append(
            f'<polyline points="{polyline(geo["delayed_segment"])}" fill="none" '
            f'stroke="{delayed_color}" stroke-width="2.2" stroke-linecap="round" '
            f'stroke-linejoin="round"/>'
        )

    for point in geo["points"]:
        color = early_color if point["i"] <= 1 else delayed_color
        parts.append(
            f'<circle cx="{point["x"]:.1f}" cy="{point["y"]:.1f}" r="2.4" fill="#ffffff" '
            f'stroke="{color}" stroke-width="1.6"/>'
        )

    # Phase labels along the bottom.
    for point in geo["points"]:
        name = phases[point["i"]] if point["i"] < len(phases) else ""
        parts.append(
            f'<text x="{point["x"]:.1f}" y="{plot["y"] + plot["h"] + 11:.1f}" '
            f'text-anchor="middle" font-size="6.5" fill="{AXIS}">'
            f"{escape(_phase_label(name))}</text>"
        )

    parts.append(
        f'<text x="{plot["x"] + plot["w"] / 2:.1f}" y="{height - 3:.1f}" '
        f'text-anchor="middle" font-size="6" fill="{AXIS}" '
        f'letter-spacing="0.6">CONTRAST PHASE</text>'
    )
    parts.append(
        f'<text x="9" y="{plot["y"] + plot["h"] / 2:.1f}" text-anchor="middle" '
        f'font-size="6" fill="{AXIS}" letter-spacing="0.6" '
        f'transform="rotate(-90 9 {plot["y"] + plot["h"] / 2:.1f})">'
        f"% SIGNAL CHANGE</text>"
    )
    parts.append("</svg>")
    return "".join(parts)


def clock_svg(clock_position, laterality=None, size=76):
    """Inline SVG of a breast clock face with one position marked.

    Mirrors the dial the clinician clicks on screen. The clock face is read as viewed
    facing the patient, per the ACR convention, so no left/right mirroring is applied —
    the laterality is stated as a letter instead of being encoded in the geometry.
    """
    import math

    centre = size / 2
    radius = size / 2 - 9

    parts = [
        f'<svg class="clock" viewBox="0 0 {size} {size}" width="{size}" height="{size}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img">',
        f'<circle cx="{centre}" cy="{centre}" r="{radius}" fill="#f8fafc" '
        f'stroke="{GRID}" stroke-width="1"/>',
    ]

    for hour in range(1, 13):
        angle = math.radians(hour * 30 - 90)
        outer = radius
        inner = radius - (4 if hour % 3 == 0 else 2.5)
        x1 = centre + math.cos(angle) * inner
        y1 = centre + math.sin(angle) * inner
        x2 = centre + math.cos(angle) * outer
        y2 = centre + math.sin(angle) * outer
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{AXIS}" stroke-width="{0.9 if hour % 3 == 0 else 0.6}"/>'
        )

    for hour, label in ((12, "12"), (3, "3"), (6, "6"), (9, "9")):
        angle = math.radians(hour * 30 - 90)
        x = centre + math.cos(angle) * (radius + 5.5)
        y = centre + math.sin(angle) * (radius + 5.5) + 2
        parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="middle" font-size="6" '
            f'fill="{AXIS}">{label}</text>'
        )

    if clock_position:
        angle = math.radians(clock_position * 30 - 90)
        x = centre + math.cos(angle) * (radius - 7)
        y = centre + math.sin(angle) * (radius - 7)
        parts.append(
            f'<line x1="{centre}" y1="{centre}" x2="{x:.1f}" y2="{y:.1f}" '
            f'stroke="{INK}" stroke-width="1.1"/>'
        )
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="#be123c" opacity="0.16"/>'
        )
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.2" fill="#be123c"/>')

    initial = {"right": "R", "left": "L", "bilateral": "B"}.get(laterality or "", "")
    parts.append(
        f'<circle cx="{centre}" cy="{centre}" r="6.5" fill="#ffffff" stroke="{GRID}"/>'
    )
    if initial:
        parts.append(
            f'<text x="{centre}" y="{centre + 2.6:.1f}" text-anchor="middle" '
            f'font-size="7.5" font-weight="700" fill="{INK}">{initial}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)
