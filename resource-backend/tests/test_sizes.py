"""Lesion sizes measured from the mask: the bounding box in canonical voxels times the spacing,
with the anatomical names given only to an axis-aligned grid."""

import math

import nibabel as nib
import numpy as np
import pytest

from app.geometry import canonical
from app.reports import schema
from app.reports.sizes import anatomical_withheld, compute_sizes, is_axis_aligned, round_tenth
from app.services.volume_reader import read_canonical
from tests.conftest import GRID, ORIGIN_LPS, SPACING


def _mask() -> np.ndarray:
    """The sub-1 fixture mask: label 1 a 3x3x2 block, label 2 a single voxel."""
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[2:5, 2:5, 1:3] = 1
    mask[8, 6, 4] = 2
    return mask


def _grid(directions=None) -> canonical.Geometry:
    if directions is None:
        directions = np.diag(SPACING)
    return canonical.Geometry(dims=GRID, directions=directions, origin=ORIGIN_LPS)


def _rotated_about_s(degrees: float) -> canonical.Geometry:
    """The grid turned `degrees` about the patient's S axis: i and j are oblique, k is not."""
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    units = np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])
    return _grid(units * np.array(SPACING)[:, None])


def test_sizes_axis_aligned():
    s = compute_sizes(_mask(), _grid(), [1])[1]
    assert s.max_linear_mm.value == 3.0 and s.volume_mm3.value == round(18 * 0.885 * 0.885 * 1.5, 1)
    assert s.transverse_mm.value == round(3 * 0.885, 1) and s.craniocaudal_mm.value == 3.0
    assert s.ap_mm.value == round(3 * 0.885, 1)


def test_every_size_is_a_computed_measurement_without_a_time():
    s = compute_sizes(_mask(), _grid(), [1])[1]
    for field in ("max_linear_mm", "ap_mm", "transverse_mm", "craniocaudal_mm", "volume_mm3"):
        measurement = getattr(s, field)
        assert measurement.source == "computed"
        assert measurement.recorded_at is None


def test_extents_map_x_to_transverse_y_to_ap_z_to_craniocaudal():
    # Three different extents, so a swapped axis cannot pass.
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[1:3, 1:5, 0:6] = 1  # 2 x 4 x 6 voxels
    s = compute_sizes(mask, _grid(), [1])[1]
    assert s.transverse_mm.value == round(2 * 0.885, 1)
    assert s.ap_mm.value == round(4 * 0.885, 1)
    assert s.craniocaudal_mm.value == 9.0
    assert s.max_linear_mm.value == 9.0


def test_a_single_voxel_measures_one_voxel():
    s = compute_sizes(_mask(), _grid(), [2])[2]
    assert s.max_linear_mm.value == 1.5
    assert s.volume_mm3.value == round(0.885 * 0.885 * 1.5, 1)


def test_sizes_count_only_their_own_label():
    both = compute_sizes(_mask(), _grid(), [1, 2])
    assert set(both) == {1, 2}
    assert both[1].volume_mm3.value == round(18 * 0.885 * 0.885 * 1.5, 1)


def test_sizes_oblique_withholds_anatomical():
    grid = _rotated_about_s(10.0)
    s = compute_sizes(_mask(), grid, [1])[1]
    assert s.ap_mm is None and s.transverse_mm is None and s.craniocaudal_mm is None
    # Orientation does not change the largest extent or the volume.
    assert s.max_linear_mm.value == 3.0
    assert s.volume_mm3.value == round(18 * 0.885 * 0.885 * 1.5, 1)


def test_an_oblique_grid_explains_why_the_anatomical_sizes_are_absent():
    reason = anatomical_withheld(_rotated_about_s(10.0))
    assert "10.0 degrees" in reason
    assert "not anatomical measurements" in reason


def test_an_aligned_grid_withholds_nothing():
    assert anatomical_withheld(_grid()) == ""


@pytest.mark.parametrize("degrees,aligned", [(0.0, True), (5.0, True), (6.0, False), (10.0, False)])
def test_alignment_holds_within_cos_0_995(degrees, aligned):
    # cos(5.7 degrees) is about 0.995.
    assert is_axis_aligned(_rotated_about_s(degrees)) is aligned


def test_two_axes_on_one_patient_axis_are_not_aligned():
    # Each axis is close to a principal axis, but not to a distinct one.
    directions = np.array([[0.885, 0.0, 0.0], [0.885, 0.01, 0.0], [0.0, 0.0, 1.5]])
    assert is_axis_aligned(_grid(directions)) is False


def test_sizes_empty_channel_all_none():
    s = compute_sizes(_mask(), _grid(), [3])[3]
    assert s == schema.Size()


def test_sizes_from_the_fixture_mask_file(loaded_service):
    mask, grid = read_canonical(loaded_service.mask, "m.nii.gz")
    s = compute_sizes(mask, grid, [1])[1]
    assert s.max_linear_mm.value == 3.0
    assert s.volume_mm3.value == 21.1
    assert s.craniocaudal_mm.value == 3.0


# --- Rounding: the validator's Math.round(v * 10) / 10, a half rounded up --------------


@pytest.mark.parametrize("value,expected", [(1.25, 1.3), (2.65, 2.7), (2 * 0.625, 1.3), (1.24, 1.2), (3.0, 3.0)])
def test_a_half_tenth_rounds_up_as_the_validator_does(value, expected):
    # Python's round() gives 1.2 for 1.25 and 2.6 for 2.65.
    assert round_tenth(value) == expected


def test_sizes_round_a_half_tenth_up():
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[0:2, 0:1, 0:1] = 1  # 2 voxels along x
    grid = _grid(np.diag([0.625, 0.885, 1.5]))
    assert compute_sizes(mask, grid, [1])[1].transverse_mm.value == 1.3


# --- A file stored in another voxel order ----------------------------------------------


def test_sizes_follow_the_canonical_axes_whatever_order_the_file_stores():
    """A NIfTI whose voxels run S, R, P (axes permuted, one flipped) on the same LPS grid
    measures as the canonical mask does: the extents are named after the patient's axes, not
    the file's."""
    spacing = (0.8, 1.0, 2.0)  # L, P, S: all different, so a swapped axis cannot pass
    canonical_mask = np.zeros(GRID, dtype=np.uint8)
    canonical_mask[1:3, 2:6, 1:4] = 1  # 2 x 4 x 3 voxels along L, P, S

    # Native axis 0 runs S, axis 1 runs R (L flipped), axis 2 runs P.
    native = canonical_mask.transpose(2, 0, 1)[:, ::-1, :].copy()
    directions_lps = np.array([[0.0, 0.0, spacing[2]], [-spacing[0], 0.0, 0.0], [0.0, spacing[1], 0.0]])
    origin_lps = np.array(ORIGIN_LPS) + (GRID[0] - 1) * np.array([spacing[0], 0.0, 0.0])
    affine = np.eye(4)
    affine[:3, :3] = (directions_lps * np.array([-1.0, -1.0, 1.0])).T  # columns, in RAS
    affine[:3, 3] = origin_lps * np.array([-1.0, -1.0, 1.0])
    raw = nib.Nifti1Image.to_bytes(nib.Nifti1Image(native, affine))

    mask, grid = read_canonical(raw, "permuted.nii.gz")
    assert np.array_equal(mask, canonical_mask)
    s = compute_sizes(mask, grid, [1])[1]
    assert s.transverse_mm.value == 1.6
    assert s.ap_mm.value == 4.0
    assert s.craniocaudal_mm.value == 6.0
    assert s.max_linear_mm.value == 6.0
    assert s.volume_mm3.value == round_tenth(24 * 0.8 * 1.0 * 2.0)
