"""Reading NRRD and NIfTI volumes from bytes.

These round-trip real files written by the real libraries, because the claim being tested is
that nibabel and pynrrd read from memory at all -- a hand-built byte string would prove only
that the parser accepts what the test invented.
"""
import builtins
import gzip
import io

import numpy as np
import nibabel as nib
import nrrd
import pytest

from app.services.volume_reader import read_array, read_canonical

VOXELS = np.arange(2 * 3 * 4, dtype=np.uint16).reshape(2, 3, 4)
AFFINE = np.array(
    [[0.0, -1.0, 0.0, 10.0], [1.0, 0.0, 0.0, -5.0], [0.0, 0.0, 2.0, 3.0], [0, 0, 0, 1.0]]
)


def _nrrd_bytes(data=VOXELS):
    # Written in the same index order the reader pins, so a transposed result is a real
    # defect rather than a fixture artefact. pynrrd's own default is "F"; the reader states
    # it explicitly, and so does this.
    buffer = io.BytesIO()
    nrrd.write(buffer, data, index_order="F")
    return buffer.getvalue()


def _nifti_bytes(data=VOXELS, affine=AFFINE):
    image = nib.Nifti1Image(data.astype(np.float64), affine)
    return image.to_bytes()


class TestReadArray:
    def test_nothing_supplied_is_none_rather_than_an_error(self):
        assert read_array(None) is None
        assert read_array(b"") is None

    def test_a_raw_nrrd_round_trips(self):
        assert np.array_equal(read_array(_nrrd_bytes(), "t2.nrrd"), VOXELS)

    def test_a_nifti_round_trips(self):
        assert np.array_equal(read_array(_nifti_bytes(), "mask.nii"), VOXELS)

    def test_a_gzipped_volume_is_recognised_by_its_bytes_not_its_name(self):
        # An object served as ".nii.gz" is sometimes a plain NIfTI and vice versa. Sniffing
        # the gzip magic is what stops that becoming a confusing "is not a gzip file".
        gzipped = gzip.compress(_nifti_bytes())
        assert np.array_equal(read_array(gzipped, "mask.nii"), VOXELS)
        assert np.array_equal(read_array(_nifti_bytes(), "mask.nii.gz"), VOXELS)

    def test_unreadable_bytes_are_none_rather_than_a_raise(self):
        assert read_array(b"not a volume at all", "junk.nrrd") is None


def _oriented_nrrd_bytes(data, directions, origin, space="left-posterior-superior"):
    buffer = io.BytesIO()
    nrrd.write(buffer, data, header={
        "space": space,
        "space directions": np.asarray(directions, dtype=float),
        "space origin": np.asarray(origin, dtype=float),
    }, index_order="F")
    return buffer.getvalue()


class TestReadCanonical:
    """The voxels in the order the viewer shows them (i -> L, j -> P, k -> S), with that grid.

    Each case puts one marker voxel at a known native index and asks where it lands. A reader
    that returned the file's own order would leave it there, which on these files is the
    mirrored or transposed position.
    """

    def _marked(self, shape, native_index):
        data = np.zeros(shape, dtype=np.int16)
        data[native_index] = 1000
        return data

    def test_an_lps_stored_nrrd_is_already_canonical(self):
        data = self._marked((4, 3, 2), (1, 2, 1))
        vol, grid = read_canonical(_oriented_nrrd_bytes(data, np.diag([0.5, 0.5, 2.0]), (10, 20, 30)), "a.nrrd")
        assert vol.shape == (4, 3, 2) and vol[1, 2, 1] == 1000
        np.testing.assert_allclose(grid.origin, (10, 20, 30))

    def test_a_ras_stored_nrrd_comes_back_with_i_and_j_reversed(self):
        # workdir_ea_tp1's storage: i runs toward R, j toward A.
        data = self._marked((4, 3, 2), (0, 0, 1))
        raw = _oriented_nrrd_bytes(data, np.diag([-0.5, -0.5, 2.0]), (10, 20, 30))
        vol, grid = read_canonical(raw, "a.nrrd")
        assert vol[3, 2, 1] == 1000
        np.testing.assert_allclose(grid.directions, np.diag([0.5, 0.5, 2.0]))
        # The origin moves to the new first voxel: the old last one along i and j.
        np.testing.assert_allclose(grid.origin, (10 - 1.5, 20 - 1.0, 30))

    def test_a_sagittal_nrrd_comes_back_permuted(self):
        # i -> P, j -> I, k -> L, so canonical i is the file's k, j its i, k its reversed j.
        data = self._marked((5, 4, 3), (1, 0, 2))
        raw = _oriented_nrrd_bytes(data, [[0, 0.8, 0], [0, 0, -2.0], [0.8, 0, 0]], (0, 0, 0))
        vol, _ = read_canonical(raw, "a.nrrd")
        assert vol.shape == (3, 5, 4)
        assert vol[2, 1, 3] == 1000

    def test_a_ras_stored_nifti_comes_back_with_i_and_j_reversed(self):
        data = self._marked((4, 3, 2), (0, 0, 1)).astype(np.float64)
        vol, _ = read_canonical(nib.Nifti1Image(data, np.diag([0.5, 0.5, 2.0, 1.0])).to_bytes(), "m.nii")
        assert vol[3, 2, 1] == 1000

    def test_an_image_without_a_patient_orientation_is_none(self):
        # No `space`: its voxels cannot be put in any order safely, so nothing is returned.
        assert read_canonical(_nrrd_bytes(), "t2.nrrd") is None

    def test_nothing_supplied_is_none(self):
        assert read_canonical(None) is None
        assert read_canonical(b"") is None


def test_no_volume_is_written_to_disk(monkeypatch, tmp_path):
    """The rule this module exists to keep: a decompressed patient image never lands on disk.

    `open` is trapped rather than checking one directory afterwards, so a temp file anywhere
    fails the test -- which is exactly how the previous implementation leaked, via
    `NamedTemporaryFile(delete=False)`.
    """
    nrrd_payload, nifti_payload = _nrrd_bytes(), _nifti_bytes()

    real_open = builtins.open
    opened = []

    def tracking_open(file, mode="r", *args, **kwargs):
        if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
            opened.append(str(file))
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", tracking_open)
    monkeypatch.chdir(tmp_path)

    assert read_array(nrrd_payload, "t2.nrrd") is not None
    assert read_array(nifti_payload, "mask.nii") is not None
    assert read_canonical(nifti_payload, "mask.nii") is not None
    assert read_canonical(_oriented_nrrd_bytes(VOXELS, np.diag([-1.0, -1.0, 1.0]), (0, 0, 0)), "a.nrrd") is not None

    assert opened == []
    assert list(tmp_path.iterdir()) == []
