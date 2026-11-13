"""Enhancement kinetics: the plot geometry of a percent-change curve.

Ported from the validator, where the same function draws the on-screen chart, so the curve
this report prints is the one the validator shows and prints. Only the geometry is ported;
the early/delayed classification the validator suggests next to its selects is not used here.

Curve convention:

    percent_change[i] = (mean_intensity[i] - mean_intensity[0]) / mean_intensity[0] * 100

so `percent_change[0]` is always 0, index 0 is pre-contrast, and index 1 is the first
post-contrast phase. A case may be missing phases, in which case the arrays are simply
shorter: never padded, never interpolated.

Plain stdlib.
"""

# ACR thresholds, p. 718. Early phase is read at the first post-contrast phase.
EARLY_SLOW_MAX = 50.0    # < 50% is slow
EARLY_MEDIUM_MAX = 100.0  # 50-100% is medium; above is fast

# Delayed phase compares the last phase's signal intensity to the early phase's.
DELAYED_BAND = 10.0  # within +/-10% is plateau


# --- Plot geometry ------------------------------------------------------------

# Keep at least this much of the y axis visible even for a flat curve, so the 50%
# early threshold is always on screen and a slow lesion still reads as slow rather
# than as a bug.
MIN_Y_TOP = 60.0
Y_HEADROOM = 1.08


def curve_geometry(percent_change, width=340, height=210, padding=(16, 14, 30, 44)):
    """Plot coordinates for a percent-change curve.

    `padding` is (top, right, bottom, left) in the same units as width/height.

    Returns a dict with the plot rect, the mapped points, the two coloured segments,
    the threshold guides that fall inside the domain, and the y domain itself. When
    there is nothing to draw, `points` is empty and `pending` is True — callers render
    an awaiting-segmentation placeholder rather than a degenerate line.
    """
    top, right, bottom, left = padding
    plot_x = left
    plot_y = top
    plot_w = max(1.0, width - left - right)
    plot_h = max(1.0, height - top - bottom)

    values = [float(v) for v in (percent_change or [])]

    if len(values) < 2:
        return {
            "pending": True,
            "width": width,
            "height": height,
            "plot": {"x": plot_x, "y": plot_y, "w": plot_w, "h": plot_h},
            "points": [],
            "early_segment": [],
            "delayed_segment": [],
            "guides": [],
            "y_domain": [0.0, MIN_Y_TOP],
            "baseline_y": plot_y + plot_h,
        }

    y_lo = min(0.0, min(values))
    y_hi = max(max(values), MIN_Y_TOP) * Y_HEADROOM
    if y_hi <= y_lo:
        y_hi = y_lo + MIN_Y_TOP

    def to_y(value):
        return plot_y + plot_h - (value - y_lo) / (y_hi - y_lo) * plot_h

    step = plot_w / (len(values) - 1)
    points = [
        {"i": i, "x": plot_x + i * step, "y": to_y(v), "value": v}
        for i, v in enumerate(values)
    ]

    guides = []
    for value, text in ((EARLY_SLOW_MAX, "50%"), (EARLY_MEDIUM_MAX, "100%")):
        if y_lo <= value <= y_hi:
            guides.append({"value": value, "y": to_y(value), "label": text})

    # The delayed band is drawn around the early phase's value, which is where the
    # ACR rule is anchored. Expressed in baseline-relative percent so it lands in the
    # same coordinate space as the curve.
    early = values[1]
    band = None
    if len(values) >= 3:
        span = (100.0 + early) * DELAYED_BAND / 100.0
        band = {
            "upper": to_y(min(early + span, y_hi)),
            "lower": to_y(max(early - span, y_lo)),
            "value": early,
        }

    return {
        "pending": False,
        "width": width,
        "height": height,
        "plot": {"x": plot_x, "y": plot_y, "w": plot_w, "h": plot_h},
        "points": points,
        "early_segment": points[:2],
        "delayed_segment": points[1:] if len(points) > 2 else [],
        "guides": guides,
        "band": band,
        "y_domain": [y_lo, y_hi],
        "baseline_y": to_y(0.0),
    }


def polyline(points):
    """SVG `points` attribute value for a run of geometry points."""
    return " ".join(f"{p['x']:.2f},{p['y']:.2f}" for p in points)
