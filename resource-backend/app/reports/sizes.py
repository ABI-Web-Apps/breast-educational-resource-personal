"""Lesion sizes, measured from the mask per channel.

The validator measures sizes in its frontend (`plugins/utils/maskGeometry.ts` `physicalSize`,
rounded and stamped in `store/findingsStore.ts`); this is the same algorithm on the backend:

- the extents are the channel's bounding box in canonical voxels times the spacing;
- `max_linear_mm` is the largest extent and `volume_mm3` the voxel count times the voxel volume,
  neither of which depends on orientation;
- AP, transverse and craniocaudal name the extents along y, x and z, and are given only when the
  grid is axis-aligned (`is_axis_aligned`). Canonicalisation reorders the axes but never
  resamples, so on a tilted grid an extent along a voxel axis is not an anatomical extent, and
  printing one as "AP 2.4 mm" would be a fabricated measurement.

Every value is rounded to 0.1 and stamped `source="computed"` with no time: nothing here can
honestly say when the mask was drawn.

numpy only, so it runs on a bare host.
"""
from typing import Iterable

import numpy as np

from app.geometry import canonical
from app.reports import schema

#: How close each voxel axis must be to a principal patient axis: cos(5.7 degrees). The
#: validator's AXIS_ALIGNMENT_TOLERANCE.
AXIS_ALIGNMENT_TOLERANCE = 0.995

_PATIENT_AXIS_NAMES = ("left-right", "anteroposterior", "craniocaudal")


def _unit_axes(geometry: canonical.Geometry) -> np.ndarray:
    """Row a is one step along voxel axis a, as a unit vector in LPS."""
    return geometry.directions / geometry.spacing[:, None]


def is_axis_aligned(geometry: canonical.Geometry) -> bool:
    """Whether every voxel axis lies within the tolerance of a principal axis, each a distinct one.

    The validator's `isAxisAligned`, which reads a direction matrix's columns; here each voxel
    axis is a row of `geometry.directions`. Two axes both near +L is not a permutation and fails.
    """
    claimed = set()
    for axis in _unit_axes(geometry):
        dominant = [p for p in range(3) if abs(axis[p]) >= AXIS_ALIGNMENT_TOLERANCE]
        if not dominant or dominant[0] in claimed:
            return False
        claimed.add(dominant[0])
    return True


def anatomical_withheld(geometry: canonical.Geometry) -> str:
    """Why the AP / transverse / craniocaudal sizes are absent on this grid, or "" when they are not.

    Printed under each finding's sizes, so a missing anatomical size reads as a refusal rather
    than an omission.
    """
    if is_axis_aligned(geometry):
        return ""
    units = np.abs(_unit_axes(geometry))
    obliquity = np.degrees(np.arccos(np.clip(units.max(axis=1), 0.0, 1.0)))
    worst = int(np.argmax(obliquity))
    nearest = int(np.argmax(units[worst]))
    return (
        f"The image is tilted {obliquity[worst]:.1f} degrees from the patient's "
        f"{_PATIENT_AXIS_NAMES[nearest]} axis, so its extents are not anatomical measurements."
    )


def _measured(value: float) -> schema.Measurement:
    return schema.Measurement(value=round(float(value), 1), source="computed", recorded_at=None)


def compute_sizes(
    mask: np.ndarray, geometry: canonical.Geometry, channels: Iterable[int]
) -> dict[int, schema.Size]:
    """Each channel's size, from a mask in the canonical order. An empty channel has every size None."""
    spacing = geometry.spacing
    voxel_volume = float(np.prod(spacing))
    aligned = is_axis_aligned(geometry)
    sizes = {}
    for channel in channels:
        coords = np.argwhere(mask == channel)
        if coords.size == 0:
            sizes[channel] = schema.Size()
            continue
        x_mm, y_mm, z_mm = (coords.max(axis=0) - coords.min(axis=0) + 1) * spacing
        size = schema.Size(
            max_linear_mm=_measured(max(x_mm, y_mm, z_mm)),
            volume_mm3=_measured(len(coords) * voxel_volume),
        )
        if aligned:
            size.ap_mm = _measured(y_mm)
            size.transverse_mm = _measured(x_mm)
            size.craniocaudal_mm = _measured(z_mm)
        sizes[channel] = size
    return sizes
