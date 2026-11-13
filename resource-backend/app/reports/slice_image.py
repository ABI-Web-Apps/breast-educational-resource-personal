"""One axial slice of a case, with a finding's mask outlined on it.

Pure: no I/O, no MinIO, which is what lets this run in the suite on a bare host. Loading the
volumes is `app.services.report`'s job. Ported from the validator, so the slice and outline
match the validator's report.

An OUTLINE, not a filled overlay: a fill hides the tissue the reader is being asked to check,
which is the entire reason the image is in the report.
"""
import io
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.geometry.canonical import GeometryMismatch

#: Window the slice on these percentiles. Fixed rather than configurable: the report is a
#: clinical document and a per-case contrast knob would make two reports incomparable.
WINDOW_PERCENTILES = (1.0, 99.0)


def _round_half_up(value: float) -> int:
    """Round like JS `Math.round`, not like numpy's default round-half-to-even.

    The validator's `maskGeometry.ts` `centroidSlice` rounds each axis with `Math.round`, which
    rounds a half up. numpy's `.round()` rounds a half to even. The two agree everywhere except
    exact `.5` centroids, and this function exists so the slice this report prints is the one
    the validator prints and jumps to.
    """
    return math.floor(value + 0.5)


def centroid_of(mask: np.ndarray, channel: int):
    """The centre of mass of `channel` as `(x, y, z)` integer indices, or None if empty.

    In array order, so the tuple indexes the array it came from: axis 0 is x (sagittal),
    axis 1 is y (coronal), axis 2 is z (axial). That holds because every mask is read in the
    canonical order (i->L, j->P, k->S, `volume_reader.read_canonical`).

    Centre of mass, not the centre of the bounding box: on a crescent-shaped lesion the box
    centre can land in the notch, and the report would then show a slice through nothing.
    Twin of the validator's `maskGeometry.ts` `scanChannel` + `centroidSlice`.
    """
    coords = np.argwhere(mask == channel)
    if coords.size == 0:
        return None
    mean = coords.mean(axis=0)
    x, y, z = (_round_half_up(v) for v in mean)
    return int(x), int(y), int(z)


def _hex_to_rgb(color_hex: str):
    value = color_hex.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def _window(slice_2d: np.ndarray) -> np.ndarray:
    """8-bit greyscale, windowed on the slice's own percentile range.

    A flat slice (all one value) has no range to stretch; it renders black rather than
    dividing by zero.
    """
    lo, hi = np.percentile(slice_2d, WINDOW_PERCENTILES)
    if hi <= lo:
        return np.zeros(slice_2d.shape, dtype=np.uint8)
    clipped = np.clip(slice_2d, lo, hi)
    return (((clipped - lo) / (hi - lo)) * 255).astype(np.uint8)


def _boundary(region: np.ndarray) -> np.ndarray:
    """The one-voxel boundary of a boolean region.

    A pixel is on the boundary when it is in the region and at least one 4-neighbour is not
    (pixels off the edge of the array count as "not in the region"). Written with shifts
    rather than scikit-image so the dependency surface stays at numpy.
    """
    padded = np.pad(region, 1, constant_values=False)
    interior = (
        padded[:-2, 1:-1] & padded[2:, 1:-1] & padded[1:-1, :-2] & padded[1:-1, 2:]
    )
    return region & ~interior


def _label_font(size: int):
    """Pillow's bundled font at `size` px; its fixed bitmap font where FreeType is unavailable."""
    try:
        return ImageFont.load_default(size=size)
    except (TypeError, OSError, ImportError):
        return ImageFont.load_default()


def _draw_labels(image: Image.Image, labels: dict) -> None:
    """The orientation letters at the middle of each edge, white with a dark outline so they
    read on bright tissue and on air alike."""
    draw = ImageDraw.Draw(image)
    font = _label_font(max(12, image.height // 24))
    width, height = image.size
    margin = 4
    for edge, text in labels.items():
        if not text:
            continue
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=2)
        w, h = right - left, bottom - top
        x, y = {
            "left": (margin, (height - h) / 2),
            "right": (width - w - margin, (height - h) / 2),
            "top": ((width - w) / 2, margin),
            "bottom": ((width - w) / 2, height - h - margin),
        }[edge]
        draw.text((x - left, y - top), text, font=font, fill=(255, 255, 255),
                  stroke_width=2, stroke_fill=(0, 0, 0))


def render_slice_png(
    volume: np.ndarray,
    mask: np.ndarray,
    channel: int,
    z: int,
    color_hex: str,
    labels: dict | None = None,
    max_px: int = 512,
) -> bytes:
    """The axial slice at `z`, with `channel`'s mask outlined in `color_hex`, as PNG bytes.

    Both volumes are in the canonical order (i -> L, j -> P, k -> S), so axial is **axis 2** and
    `z` is the slice number the viewer shows. The slice is `volume[:, :, z]`, transposed before it
    is drawn: the array is indexed `[i, j, k]`, while an image wants rows of j and columns of i --
    the viewer's axial layout, with the patient's left on screen right and anterior at the top.

    `labels` ({left, right, top, bottom}, from `canonical.view_labels("z", grid)`) are drawn at
    the edges, after any resize so they stay legible.

    Raises IndexError when `z` is outside the volume -- a silently clamped index would print
    a slice the caption does not describe.

    Raises GeometryMismatch when `mask` is not the same size as `volume`. The caller has already
    checked the two are one grid (`canonical.same_grid`); this is the last guard. Drawing the
    slice anyway with no outline would silently produce a clinical document that looks complete
    but has quietly dropped the one piece of evidence a reader can check against the tissue.
    """
    if not 0 <= z < volume.shape[2]:
        raise IndexError(f"slice {z} is outside a volume of depth {volume.shape[2]}")
    if mask.shape != volume.shape:
        raise GeometryMismatch(
            "The image and the mask are not the same size.",
            f"volume {tuple(volume.shape)}, mask {tuple(mask.shape)}",
            step="slice_image",
        )

    rgb = np.stack([_window(np.asarray(volume[:, :, z].T, dtype=float))] * 3, axis=-1)

    outline = _boundary(mask[:, :, z].T == channel)
    rgb[outline] = _hex_to_rgb(color_hex)

    image = Image.fromarray(rgb, mode="RGB")
    if max(image.size) > max_px:
        scale = max_px / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.NEAREST,  # nearest, so the one-pixel outline survives the resize
        )
    if labels:
        _draw_labels(image, labels)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
