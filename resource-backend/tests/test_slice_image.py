"""The per-finding slice image, as arithmetic.

Pure numpy and Pillow, so this runs on a bare host. The centroid is a centre of mass rather
than a bounding-box centre, matching the validator's maskGeometry.ts: on a crescent lesion the
box centre can land in the notch, and the report would then point at a slice through nothing.
"""
import io

import numpy as np
import pytest

from app.geometry.canonical import GeometryMismatch
from app.reports.slice_image import centroid_of, render_slice_png


def _mask(shape=(8, 10, 10)):
    return np.zeros(shape, dtype=np.uint8)


class TestCentroidOf:
    def test_returns_none_for_an_empty_channel(self):
        assert centroid_of(_mask(), channel=1) is None

    def test_ignores_other_channels(self):
        mask = _mask()
        mask[4, 3, 2] = 2
        assert centroid_of(mask, channel=1) is None

    def test_is_the_centre_of_mass(self):
        mask = _mask()
        mask[4, 4, 2] = 1
        mask[4, 4, 4] = 1
        # Midway in z (axis 2), unmoved in x and y.
        assert centroid_of(mask, channel=1) == (4, 4, 3)

    def test_is_not_the_bounding_box_centre(self):
        # An L: the box centre sits on empty voxels, the mass centre does not.
        mask = _mask()
        mask[1, 1, 1] = 1
        mask[2, 1, 1] = 1
        mask[1, 2, 1] = 1
        x, y, z = centroid_of(mask, channel=1)
        assert (x, y, z) == (1, 1, 1)
        assert mask[x, y, z] == 1

    def test_breaks_an_exact_half_tie_upward(self):
        # z-mean is exactly 0.5: round-half-to-even would give 0, round-half-up (matching
        # JS's Math.round, which is what centroidSlice uses) gives 1. Only one axis needs
        # to carry the tie -- centroid_of applies the same rounding function independently
        # to each of x, y, z, so pinning it on z exercises the same code path an x or y tie
        # would exercise.
        mask = _mask()
        mask[5, 5, 0] = 1
        mask[5, 5, 1] = 1
        assert centroid_of(mask, channel=1) == (5, 5, 1)


class TestRenderSlicePng:
    def test_returns_png_bytes(self):
        volume = np.random.default_rng(0).random((8, 10, 10)) * 100
        mask = _mask()
        mask[4:6, 4:6, 3] = 1
        png = render_slice_png(volume, mask, channel=1, z=3, color_hex="#ff7043")
        assert png[:8] == b"\x89PNG\r\n\x1a\n"

    def test_draws_the_outline_in_the_finding_colour(self):
        from PIL import Image

        volume = np.zeros((20, 20, 3))          # black background
        mask = _mask((20, 20, 3))
        mask[8:12, 8:12, 1] = 1
        png = render_slice_png(volume, mask, channel=1, z=1, color_hex="#ff0000", max_px=20)
        pixels = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
        reds = np.all(pixels == np.array([255, 0, 0]), axis=-1)
        assert reds.any(), "the outline was not drawn"

    def test_leaves_the_interior_showing_the_image(self):
        from PIL import Image

        volume = np.zeros((20, 20, 3))
        mask = _mask((20, 20, 3))
        mask[6:14, 6:14, 1] = 1
        png = render_slice_png(volume, mask, channel=1, z=1, color_hex="#ff0000", max_px=20)
        pixels = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
        # An outline, not a fill: the middle of the region is still background.
        assert tuple(pixels[10, 10]) != (255, 0, 0)

    def test_rejects_a_slice_index_outside_the_volume(self):
        with pytest.raises(IndexError):
            render_slice_png(np.zeros((3, 4, 4)), _mask((3, 4, 4)), 1, 9, "#ffffff")

    def test_rejects_a_mask_on_a_different_grid_than_the_volume(self):
        volume = np.zeros((3, 4, 4))
        mismatched_mask = _mask((3, 5, 5))
        with pytest.raises(GeometryMismatch) as excinfo:
            render_slice_png(volume, mismatched_mask, channel=1, z=0, color_hex="#ffffff")
        # `step` is what a caller branches or logs on to know which computation broke.
        assert excinfo.value.step == "slice_image"


class TestAxisConvention:
    """Axial is axis 2, and every fixture here has three different axis lengths.

    The rest of this file uses (8, 10, 10) and (3, 20, 20), where two of the three axes match
    -- an axis-0/axis-2 swap is invisible against those and the report printed a sagittal
    reformat under an "axial slice N" caption for every finding in every report.

    The report reads every volume in the canonical order (`volume_reader.read_canonical`), so
    voxel axis 0 runs L-R and axis 2 runs S-I. The viewer agrees: an axial slice is a plane of
    constant k, with rows of j and columns of i.
    """

    def _mask_4_6_8(self):
        """x=4, y=6, z=8, with a 2x3 block on axial slice 5."""
        mask = np.zeros((4, 6, 8), dtype=np.uint8)
        mask[1:3, 2:5, 5] = 1
        return mask

    def test_the_centroid_is_reported_in_array_order_x_y_z(self):
        mask = np.zeros((4, 6, 8), dtype=np.uint8)
        mask[1, 2, 5] = 1
        x, y, z = centroid_of(mask, channel=1)
        assert (x, y, z) == (1, 2, 5)
        # The tuple must index the array it came from. A mislabelled order reads a voxel
        # that is not the lesion -- here, out of bounds on axis 2 entirely.
        assert mask[x, y, z] == 1

    def test_renders_a_slice_index_that_only_the_axial_axis_admits(self):
        # z=5 is outside axis 0 (length 4) and well inside axis 2 (length 8). Indexing
        # axis 0 raises here rather than printing the wrong plane.
        volume = np.zeros((4, 6, 8))
        png = render_slice_png(volume, self._mask_4_6_8(), channel=1, z=5, color_hex="#ff0000")
        assert png[:8] == b"\x89PNG\r\n\x1a\n"

    def test_the_printed_slice_is_the_axial_plane_shaped_height_by_width(self):
        from PIL import Image

        volume = np.zeros((4, 6, 8))
        png = render_slice_png(
            volume, self._mask_4_6_8(), channel=1, z=5, color_hex="#ff0000", max_px=64
        )
        pixels = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
        # Rows are y, columns are x: the viewer's axial layout.
        assert pixels.shape[:2] == (6, 4)

    def test_the_outline_lands_where_the_lesion_is(self):
        from PIL import Image

        volume = np.zeros((4, 6, 8))
        png = render_slice_png(
            volume, self._mask_4_6_8(), channel=1, z=5, color_hex="#ff0000", max_px=64
        )
        pixels = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
        reds = np.all(pixels == np.array([255, 0, 0]), axis=-1)
        rows, cols = np.nonzero(reds)
        # mask[1:3, 2:5, 5] -> x 1..2, y 2..4 -> rows (y) 2..4, cols (x) 1..2.
        assert (int(rows.min()), int(rows.max())) == (2, 4)
        assert (int(cols.min()), int(cols.max())) == (1, 2)

    def test_rejects_a_slice_index_outside_the_axial_axis(self):
        # Axis 0 is 8 long and axis 2 is 4 long: bound-checking the wrong axis accepts this
        # and prints a slice the caption does not describe.
        volume = np.zeros((8, 6, 4))
        mask = np.zeros((8, 6, 4), dtype=np.uint8)
        with pytest.raises(IndexError):
            render_slice_png(volume, mask, channel=1, z=5, color_hex="#ffffff")


class TestOrientationLetters:
    """The report's slice carries the viewer's letters, so a reader can tell left from right
    without trusting that the image follows a convention."""

    LABELS = {"left": "R", "right": "L", "top": "A", "bottom": "P"}

    def _lit(self, labels):
        # A black slice with nothing outlined: anything lit is a letter.
        volume = np.zeros((160, 120, 3))
        mask = np.zeros(volume.shape, dtype=np.uint8)
        png = render_slice_png(volume, mask, channel=1, z=1, color_hex="#ff0000", labels=labels)
        from PIL import Image

        return np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).max(axis=-1) > 0

    def test_each_letter_sits_at_its_own_edge(self):
        lit = self._lit(self.LABELS)
        h, w = lit.shape  # rows are y (120), columns x (160)
        middle_rows, middle_cols = slice(h // 3, 2 * h // 3), slice(w // 3, 2 * w // 3)
        assert lit[middle_rows, : w // 6].any(), "left"
        assert lit[middle_rows, -w // 6:].any(), "right"
        assert lit[: h // 6, middle_cols].any(), "top"
        assert lit[-h // 6:, middle_cols].any(), "bottom"
        # The centre and the corners are the image's, not the letters'.
        assert not lit[middle_rows, middle_cols].any()
        for corner in (lit[: h // 6, : w // 6], lit[: h // 6, -w // 6:], lit[-h // 6:, : w // 6], lit[-h // 6:, -w // 6:]):
            assert not corner.any()

    def test_no_letters_are_drawn_without_labels(self):
        assert not self._lit(None).any()
