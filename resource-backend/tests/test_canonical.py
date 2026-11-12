"""The canonical voxel order (i->L, j->P, k->S) and the geometry that goes with it.

Driven by the shared fixture `tests/fixtures/orientation_cases.json`, which the app also runs
through the engine, so the backend and the viewer are held to the same answers. nibabel's
`apply_orientation` and SimpleITK's `DICOMOrientImageFilter` serve as independent oracles.
"""
import itertools
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.geometry import canonical
from app.geometry.canonical import OrientationError
from app.services.nrrd_header import parse_nrrd_header

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "orientation_cases.json").read_text())
CASES = {case["id"]: case for case in FIXTURE["cases"]}
NRRD_IDS = [cid for cid, case in CASES.items() if case["source"] == "nrrd"]
NIFTI_IDS = [cid for cid, case in CASES.items() if case["source"] == "nifti"]
OK_IDS = [cid for cid, case in CASES.items() if "error" not in case["expect"]]
ERROR_IDS = [cid for cid, case in CASES.items() if "error" in case["expect"]]
DATA_IDS = [cid for cid, case in CASES.items() if "data" in case]


def _nifti_image(header):
    img = nib.Nifti1Image(np.zeros(header["dims"], dtype=np.uint8), None)
    sform = None if header["sform"] is None else np.array(header["sform"], dtype=float)
    qform = None if header["qform"] is None else np.array(header["qform"], dtype=float)
    img.set_sform(sform, code=header["sform_code"])
    img.set_qform(qform, code=header["qform_code"])
    return img


def _geometry(case):
    if case["source"] == "nrrd":
        return canonical.nrrd_geometry(case["header"])
    return canonical.nifti_geometry(_nifti_image(case["header"]))


def _resolve(case):
    geometry = _geometry(case)
    transform = canonical.canonical_transform(geometry)
    return geometry, transform, canonical.reoriented_geometry(geometry, transform)


def _native_array(case):
    dims = case["header"]["sizes"]
    return np.array(case["data"]["native_f"]).reshape(dims, order="F")


# --- the fixture ---------------------------------------------------------------------------------


@pytest.mark.parametrize("case_id", OK_IDS)
def test_transform_and_canonical_geometry_match_the_fixture(case_id):
    case = CASES[case_id]
    expect = case["expect"]
    _, transform, geometry = _resolve(case)

    assert list(transform.perm) == expect["perm"]
    assert list(transform.flip) == expect["flip"]
    assert list(geometry.dims) == expect["dims"]
    np.testing.assert_allclose(geometry.spacing, expect["spacing"], rtol=0, atol=1e-9)
    np.testing.assert_allclose(geometry.directions, expect["directions"], rtol=0, atol=1e-9)
    np.testing.assert_allclose(geometry.origin, expect["origin"], rtol=0, atol=1e-9)
    np.testing.assert_allclose(transform.obliquity_deg, expect["obliquity_deg"], rtol=0, atol=1e-6)


@pytest.mark.parametrize("case_id", OK_IDS)
@pytest.mark.parametrize("axis", ["z", "y", "x"])
def test_view_labels_match_the_fixture(case_id, axis):
    _, _, geometry = _resolve(CASES[case_id])
    assert canonical.view_labels(axis, geometry) == CASES[case_id]["expect"]["labels"][axis]


@pytest.mark.parametrize("case_id", ERROR_IDS)
def test_refusals_carry_the_fixture_code(case_id):
    case = CASES[case_id]
    with pytest.raises(OrientationError) as raised:
        _resolve(case)
    assert raised.value.code == case["expect"]["error"]
    assert raised.value.detail, "a refusal must say why"


@pytest.mark.parametrize("case_id", DATA_IDS)
def test_voxels_are_reordered_exactly_as_the_fixture_says(case_id):
    case = CASES[case_id]
    _, transform, geometry = _resolve(case)
    out = canonical.reorient(_native_array(case), transform)

    assert list(out.shape) == list(geometry.dims)
    assert out.flatten(order="F").tolist() == case["data"]["canonical_f"]


# --- invariants every accepted case must satisfy -----------------------------------------------


@pytest.mark.parametrize("case_id", OK_IDS)
def test_canonical_axes_point_left_posterior_superior(case_id):
    _, _, geometry = _resolve(CASES[case_id])
    assert nib.aff2axcodes(canonical.ras_affine(geometry)) == ("L", "P", "S")


@pytest.mark.parametrize("case_id", OK_IDS)
def test_every_voxel_keeps_its_patient_position(case_id):
    native, transform, reoriented = _resolve(CASES[case_id])
    corners = itertools.product(*[(0, n - 1) for n in reoriented.dims])
    for c in corners:
        n = [0, 0, 0]
        for axis, native_axis in enumerate(transform.perm):
            size = native.dims[native_axis]
            n[native_axis] = size - 1 - c[axis] if transform.flip[axis] else c[axis]
        before = native.origin + np.asarray(n) @ native.directions
        after = reoriented.origin + np.asarray(c) @ reoriented.directions
        np.testing.assert_allclose(after, before, rtol=0, atol=1e-9)


@pytest.mark.parametrize("case_id", DATA_IDS)
def test_to_native_undoes_reorient(case_id):
    case = CASES[case_id]
    _, transform, _ = _resolve(case)
    native = _native_array(case)
    np.testing.assert_array_equal(canonical.to_native(canonical.reorient(native, transform), transform), native)


def test_writes_through_the_view_land_in_the_native_array():
    case = CASES["permuted_sagittal"]
    _, transform, _ = _resolve(case)
    native = _native_array(case).astype(np.int64)
    view = canonical.reorient_view(native, transform)

    view[1, 2, 0] = -7  # canonical (1, 2, 0) = native (i=2, j=2, k=1): j is flipped, n_j = 3

    assert native[2, 2, 1] == -7
    assert np.count_nonzero(native == -7) == 1


def test_reorient_returns_a_copy():
    case = CASES["ras_stored_lps_space"]
    _, transform, _ = _resolve(case)
    native = _native_array(case)
    out = canonical.reorient(native, transform)
    out[...] = 0
    assert native.any()


# --- independent oracles -------------------------------------------------------------------------


def _small(geometry):
    """The same axes and origin on a grid of at most 5 voxels per side: the order is what matters."""
    return canonical.Geometry(dims=tuple(min(n, 5) for n in geometry.dims),
                              directions=geometry.directions, origin=geometry.origin)


@pytest.mark.parametrize("case_id", [cid for cid in OK_IDS if cid in NRRD_IDS])
def test_agrees_with_nibabel_apply_orientation(case_id):
    native = _small(_geometry(CASES[case_id]))
    transform = canonical.canonical_transform(native)
    data = np.random.default_rng(0).integers(0, 255, size=native.dims, dtype=np.uint8)

    ornt = nib.orientations.io_orientation(canonical.ras_affine(native))
    to_lps = nib.orientations.ornt_transform(ornt, nib.orientations.axcodes2ornt(("L", "P", "S")))
    expected = nib.orientations.apply_orientation(data, to_lps)

    np.testing.assert_array_equal(canonical.reorient(data, transform), expected)


# --- other orientations (mask variants) --------------------------------------------------------


@pytest.mark.parametrize("case_id", OK_IDS)
def test_rai_variant_points_right_anterior_inferior(case_id):
    native = _geometry(CASES[case_id])
    transform = canonical.orientation_transform(native, "RAI")
    assert nib.aff2axcodes(canonical.ras_affine(canonical.reoriented_geometry(native, transform))) == ("R", "A", "I")


def test_unknown_axis_codes_are_rejected():
    native = _geometry(CASES["identity_lps"])
    for codes in ("LPX", "LLS", "LP", "lpsa"):
        with pytest.raises(ValueError):
            canonical.orientation_transform(native, codes)


# --- NIfTI affines -------------------------------------------------------------------------------


@pytest.mark.parametrize("case_id", [cid for cid in OK_IDS if cid in NRRD_IDS])
def test_ras_affine_round_trips_through_a_nifti_header(case_id):
    _, _, geometry = _resolve(CASES[case_id])
    img = nib.Nifti1Image(np.zeros(geometry.dims, dtype=np.uint8), canonical.ras_affine(geometry))
    img.set_sform(canonical.ras_affine(geometry), code=1)
    img.set_qform(canonical.ras_affine(geometry), code=1)
    assert canonical.same_grid(canonical.nifti_geometry(img), geometry) == []


def test_ras_affine_of_an_lps_grid():
    geometry = canonical.Geometry(dims=(4, 3, 2), directions=np.diag([1.0, 2.0, 3.0]), origin=np.array([10.0, 20.0, 30.0]))
    expected = np.array([[-1, 0, 0, -10], [0, -2, 0, -20], [0, 0, 3, 30], [0, 0, 0, 1]], dtype=float)
    np.testing.assert_array_equal(canonical.ras_affine(geometry), expected)


def test_a_4d_nifti_with_one_volume_is_three_dimensional():
    img = nib.Nifti1Image(np.zeros((4, 3, 2, 1), dtype=np.uint8), np.eye(4))
    img.set_sform(np.eye(4), code=1)
    assert canonical.nifti_geometry(img).dims == (4, 3, 2)


def test_a_true_4d_nifti_is_refused():
    img = nib.Nifti1Image(np.zeros((4, 3, 2, 5), dtype=np.uint8), np.eye(4))
    img.set_sform(np.eye(4), code=1)
    with pytest.raises(OrientationError) as raised:
        canonical.nifti_geometry(img)
    assert raised.value.code == "not_3d"


# --- the same grid -------------------------------------------------------------------------------


def _grid(**changes):
    base = dict(dims=(4, 3, 2), directions=np.diag([0.885, 0.885, 1.5]), origin=np.array([-175.54, -159.94, -84.44]))
    base.update(changes)
    return canonical.Geometry(**base)


def test_identical_grids_match():
    assert canonical.same_grid(_grid(), _grid()) == []


def test_float32_storage_rounding_is_tolerated():
    rounded = _grid(origin=np.array([-175.54, -159.94, -84.44], dtype=np.float32).astype(float),
                    directions=np.diag(np.array([0.885, 0.885, 1.5], dtype=np.float32).astype(float)))
    assert canonical.same_grid(rounded, _grid()) == []


@pytest.mark.parametrize("field, changes", [
    ("dims", {"dims": (4, 3, 3)}),
    ("spacing", {"directions": np.diag([0.885, 0.886, 1.5])}),
    ("direction", {"directions": np.array([[0.885, 0.002, 0], [0, 0.885, 0], [0, 0, 1.5]])}),
    ("origin", {"origin": np.array([-175.54, -159.94, -84.43])}),
])
def test_each_kind_of_mismatch_is_named(field, changes):
    mismatches = canonical.same_grid(_grid(**changes), _grid())
    assert [m.field for m in mismatches] == [field]
    assert mismatches[0].a is not None and mismatches[0].b is not None


# --- the backend's own header parser feeds straight in -------------------------------------------


def test_a_parsed_nrrd_header_feeds_nrrd_geometry():
    header = (
        b"NRRD0004\n"
        b"type: short\n"
        b"dimension: 3\n"
        b"space: left-posterior-superior\n"
        b"sizes: 512 512 156\n"
        b"space directions: (-0.625,0,0) (0,-0.625,0) (0,0,1.3999974193548388)\n"
        b"kinds: domain domain domain\n"
        b"endian: little\n"
        b"encoding: raw\n"
        b"space origin: (155.93700000000001,116.562,-70.687600000000003)\n"
        b"\n"
    )
    geometry = canonical.nrrd_geometry(parse_nrrd_header(header))
    transform = canonical.canonical_transform(geometry)
    assert transform.perm == (0, 1, 2)
    assert transform.flip == (True, True, False)
    assert not transform.is_identity


# --- what the API serves: /headers entries and canonical z-planes ---------------------------------


def _parsed(directions, sizes=(4, 3, 2), origin=(10.0, 20.0, 30.0), space="left-posterior-superior"):
    return {"space": space, "sizes": list(sizes), "space_directions": [list(d) for d in directions],
            "space_origin": list(origin)}


def test_a_headers_entry_describes_the_canonical_grid():
    summary = canonical.header_summary(_parsed([[-0.5, 0, 0], [0, -0.5, 0], [0, 0, 2]]))
    assert summary["space"] == "left-posterior-superior"
    assert summary["dimensions"] == [4, 3, 2]
    np.testing.assert_allclose(summary["spacing"], [0.5, 0.5, 2])
    np.testing.assert_allclose(summary["space_origin"], [8.5, 19, 30])
    np.testing.assert_allclose(summary["space_directions"], [[0.5, 0, 0], [0, 0.5, 0], [0, 0, 2]])
    assert summary["transform"] == {"perm": [0, 1, 2], "flip": [True, True, False], "obliquity_deg": [0.0, 0.0, 0.0]}


def test_a_headers_entry_refuses_an_unoriented_image():
    with pytest.raises(OrientationError) as raised:
        canonical.header_summary(_parsed([[1, 0, 0], [0, 1, 0], [0, 0, 1]], space=None))
    assert raised.value.code == "no_space"


@pytest.mark.parametrize("flip_k, k, expected", [(False, 0, 0), (False, 4, 4), (True, 0, 4), (True, 4, 0)])
def test_a_canonical_slice_index_maps_to_the_files_own(flip_k, k, expected):
    transform = canonical.Transform(perm=(0, 1, 2), flip=(True, False, flip_k), obliquity_deg=(0, 0, 0))
    assert canonical.native_slice_index(transform, (3, 3, 5), k) == expected


def test_a_canonical_slice_index_out_of_range_is_refused():
    transform = canonical.Transform(perm=(0, 1, 2), flip=(False, False, True), obliquity_deg=(0, 0, 0))
    for k in (-1, 5):
        with pytest.raises(IndexError):
            canonical.native_slice_index(transform, (3, 3, 5), k)


def test_no_single_file_plane_is_a_canonical_axial_plane_of_a_permuted_file():
    transform = canonical.Transform(perm=(2, 0, 1), flip=(False, False, True), obliquity_deg=(0, 0, 0))
    with pytest.raises(canonical.PreviewUnavailable):
        canonical.native_slice_index(transform, (4, 3, 2), 0)


@pytest.mark.parametrize("directions", [
    [[1, 0, 0], [0, 1, 0], [0, 0, 2]],        # LPS-stored: the identity
    [[-1, 0, 0], [0, -1, 0], [0, 0, 2]],      # RAS-stored, like workdir_ea_tp1
    [[0, 1, 0], [1, 0, 0], [0, 0, 2]],        # rows and columns swapped in-plane
    [[0, -1, 0], [-1, 0, 0], [0, 0, -2]],     # swapped, both reversed, and k reversed
])
def test_a_served_plane_is_the_canonical_volumes_plane(directions):
    sizes = (5, 4, 3)
    native = canonical.Geometry(dims=sizes, directions=directions, origin=(0, 0, 0))
    transform = canonical.canonical_transform(native)
    volume = np.random.default_rng(3).integers(0, 65535, size=sizes, dtype=np.uint16)
    expected = canonical.reorient(volume, transform)

    for k in range(expected.shape[2]):
        n = canonical.native_slice_index(transform, sizes, k)
        file_plane = volume[:, :, n].T.tobytes()  # NRRD order: i fastest
        served = canonical.canonical_plane(file_plane, 2, sizes, transform)
        assert served == expected[:, :, k].T.tobytes(), f"canonical slice {k}"
