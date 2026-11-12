"""The canonical voxel order, and the one place the backend converts to and from it.

Canonical order: voxel index i increases toward the patient's Left, j toward Posterior and k
toward Superior. Axis codes here use the TOWARD convention of DICOM, nibabel and SimpleITK, so
"LPS" names that order (legacy ITK and ITK-SNAP call the same order "RAI").

Files stay in their native order. Everything exchanged with the frontend is canonical. Each native
axis is assigned the anatomical axis it is nearest to, and flipped when it points the other way.
That is a permutation plus flips, never a resampling, so obliquity is kept in the geometry
instead of being snapped away.

The engine (`src/ts/Utils/orientation.ts`) implements the same rule for the images it loads, and
`tests/fixtures/orientation_cases.json` holds both to the same answers. That is also why the
nearest-axis rule is written out here instead of delegating to `nibabel.io_orientation`, whose
tie-breaking changed between 5.3 and 5.4. The tests use nibabel and SimpleITK as oracles.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

class GeometryMismatch(Exception):
    """Two volumes that must line up voxel for voxel do not (the report's slice image raises it).

    Carries a {step, summary, detail} shape: `summary` is for the reader, `detail` for the log.
    """

    def __init__(self, summary: str, detail: str, step: str = "geometry"):
        super().__init__(summary)
        self.step = step
        self.summary = summary
        self.detail = detail


#: Grids count as the same within float32 storage rounding and nothing more. A NIfTI affine is
#: stored as float32, which is about 2e-5 mm at 175 mm.
SPACING_TOL_MM = 1e-4
DIRECTION_TOL = 1e-4
ORIGIN_TOL_MM = 1e-3

#: A screen axis more than 1 degree off an anatomical axis also gets that axis's letter (the rule
#: of 3D Slicer's GetDirectionLabel).
LABEL_TOL = math.sin(math.radians(1.0))

#: At 45 degrees an axis is equally near two anatomical axes, so it has no nearest one.
_AMBIGUOUS_COS = math.cos(math.radians(45.0)) + 1e-9

#: NRRD space -> the per-component signs that turn its coordinates into LPS.
_LPS_SIGNS = {
    "left-posterior-superior": (1.0, 1.0, 1.0),
    "lps": (1.0, 1.0, 1.0),
    "right-anterior-superior": (-1.0, -1.0, 1.0),
    "ras": (-1.0, -1.0, 1.0),
    "left-anterior-superior": (1.0, -1.0, 1.0),
    "las": (1.0, -1.0, 1.0),
}
_TIME_SPACES = {"rast", "last", "lpst"}
_NON_ANATOMICAL_SPACES = {"3d-right-handed", "3d-left-handed"}

#: TOWARD letter -> (patient axis in LPS, sign).
_LETTERS = {"L": (0, 1), "R": (0, -1), "P": (1, 1), "A": (1, -1), "S": (2, 1), "I": (2, -1)}

#: Each view's screen-right and screen-down steps in canonical index space, as the engine
#: draws them (SliceRenderPipeline.flipDisplayImageByAxis). This mirrors the engine, and the shared
#: fixture keeps the two in step.
_VIEW_LAYOUT = {
    "z": ((1, 0, 0), (0, 1, 0)),   # axial: right = +i, down = +j
    "y": ((1, 0, 0), (0, 0, -1)),  # coronal: right = +i, down = -k
    "x": ((0, 1, 0), (0, 0, -1)),  # sagittal: right = +j, down = -k
}

_RAS_FROM_LPS = np.array([-1.0, -1.0, 1.0])


class OrientationError(ValueError):
    """A volume whose patient orientation cannot be established. It is refused, never guessed."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True, eq=False)
class Geometry:
    """A voxel grid in patient space.

    `directions[a]` is one step along voxel axis a, in LPS millimetres. Its length is that axis's
    spacing. `origin` is the LPS position of the centre of voxel (0, 0, 0).
    """

    dims: tuple[int, int, int]
    directions: np.ndarray
    origin: np.ndarray

    def __post_init__(self):
        object.__setattr__(self, "dims", tuple(int(n) for n in self.dims))
        object.__setattr__(self, "directions", np.asarray(self.directions, dtype=float).reshape(3, 3))
        object.__setattr__(self, "origin", np.asarray(self.origin, dtype=float).reshape(3))

    @property
    def spacing(self) -> np.ndarray:
        return np.linalg.norm(self.directions, axis=1)


@dataclass(frozen=True)
class Transform:
    """From the native voxel order to a target order.

    `perm[c]` is the native axis that becomes axis c. `flip[c]` means index c runs opposite to that
    native axis (c = n - 1 - native). `obliquity_deg[c]` is the angle between axis c and its
    anatomical axis.
    """

    perm: tuple[int, int, int]
    flip: tuple[bool, bool, bool]
    obliquity_deg: tuple[float, float, float]

    @property
    def is_identity(self) -> bool:
        return self.perm == (0, 1, 2) and not any(self.flip)


@dataclass(frozen=True)
class GridMismatch:
    field: str  # "dims" | "spacing" | "direction" | "origin"
    a: object
    b: object


def nrrd_geometry(header: dict) -> Geometry:
    """An NRRD's geometry, from the keys `nrrd_header.parse_nrrd_header` returns."""
    space = header.get("space")
    if not space:
        raise OrientationError("no_space", "the header has no 'space' field, so its patient orientation is unknown")
    name = space.strip().lower()
    if name.endswith("-time") or name in _TIME_SPACES:
        raise OrientationError("time_space", f"space '{space}' is a time series; only 3D volumes are supported")
    if name == "scanner-xyz":
        raise OrientationError(
            "scanner_space",
            "space 'scanner-xyz' is in scanner coordinates, whose patient orientation depends on how the "
            "patient lay (breast MRI is acquired prone)",
        )
    if name in _NON_ANATOMICAL_SPACES:
        raise OrientationError("non_anatomical_space", f"space '{space}' has no anatomical meaning")
    if name not in _LPS_SIGNS:
        raise OrientationError("unknown_space", f"space '{space}' is not a recognised anatomical space")

    vectors = header.get("space_directions")
    if not vectors:
        raise OrientationError("no_directions", "the header has no 'space directions'")
    sizes = list(header.get("sizes") or [])
    if len(sizes) != 3 or len(vectors) != 3 or any(v is None for v in vectors):
        raise OrientationError("not_3d", f"expected 3 spatial axes, got sizes {sizes}")
    origin = header.get("space_origin")
    if origin is None:
        raise OrientationError("no_origin", "the header has no 'space origin', so the grid has no patient position")

    signs = np.array(_LPS_SIGNS[name])
    return _checked(Geometry(dims=sizes, directions=np.asarray(vectors, dtype=float) * signs,
                             origin=np.asarray(origin, dtype=float) * signs))


def nifti_geometry(img) -> Geometry:
    """A NIfTI image's geometry: the sform when its code is set, otherwise the qform. Never a guess."""
    shape = tuple(int(n) for n in img.shape)
    if len(shape) < 3 or any(n != 1 for n in shape[3:]):
        raise OrientationError("not_3d", f"expected a 3D volume, got shape {shape}")
    dims = shape[:3]
    header = img.header
    sform_code, qform_code = int(header["sform_code"]), int(header["qform_code"])
    if sform_code == 0 and qform_code == 0:
        raise OrientationError(
            "no_orientation", "qform_code and sform_code are both 0, so the file has no patient orientation"
        )

    sform = _from_ras(dims, header.get_sform()) if sform_code > 0 else None
    qform = _from_ras(dims, header.get_qform()) if qform_code > 0 else None
    if sform is not None and qform is not None:
        disagreement = _forms_disagree(sform, qform)
        if disagreement:
            raise OrientationError("qform_sform_disagree", f"the qform and sform describe different grids: {disagreement}")
    return _checked(sform if sform is not None else qform)


#: The qform and sform agree when they place every voxel within this fraction of a voxel. A qform
#: is rigid, so for a sheared grid it can only hold the nearest rigid matrix. That approximation
#: differs from the sform by hundredths of a millimetre, and is not a disagreement.
_FORMS_AGREE_VOXELS = 0.1


def _forms_disagree(sform: Geometry, qform: Geometry) -> str | None:
    """Why two descriptions of one file would make readers place its voxels differently, if they would."""
    s, q = canonical_transform(sform), canonical_transform(qform)
    if (s.perm, s.flip) != (q.perm, q.flip):
        return "they order the voxels differently"
    corners = np.array(list(np.ndindex(2, 2, 2))) * (np.asarray(sform.dims) - 1)
    apart = np.linalg.norm((sform.origin + corners @ sform.directions) - (qform.origin + corners @ qform.directions), axis=1)
    limit = _FORMS_AGREE_VOXELS * float(np.min(sform.spacing))
    if apart.max() > limit:
        return f"they place corner voxels {apart.max():.3f} mm apart (limit {limit:.3f} mm)"
    return None


def orientation_transform(geometry: Geometry, codes: str = "LPS") -> Transform:
    """The transform into the voxel order that `codes` names, e.g. "LPS" or "RAI" (TOWARD)."""
    target = _parse_codes(codes)
    units = geometry.directions / geometry.spacing[:, None]
    nearest = np.argmax(np.abs(units), axis=1)
    strength = np.abs(units[np.arange(3), nearest])
    obliquity = np.degrees(np.arccos(np.clip(strength, 0.0, 1.0)))
    if np.any(strength <= _AMBIGUOUS_COS) or len(set(nearest.tolist())) != 3:
        raise OrientationError(
            "ambiguous_oblique",
            f"a voxel axis is {obliquity.max():.1f} degrees from every anatomical axis, so it has no nearest one",
        )

    native_axis_of = {int(patient_axis): native for native, patient_axis in enumerate(nearest)}
    perm, flip, oblique = [], [], []
    for patient_axis, sign in target:
        native = native_axis_of[patient_axis]
        perm.append(native)
        flip.append(bool(np.sign(units[native, patient_axis]) != sign))
        oblique.append(float(obliquity[native]))
    return Transform(perm=tuple(perm), flip=tuple(flip), obliquity_deg=tuple(oblique))


def canonical_transform(geometry: Geometry) -> Transform:
    """The transform into the canonical order (i->L, j->P, k->S)."""
    return orientation_transform(geometry, "LPS")


def reoriented_geometry(geometry: Geometry, transform: Transform) -> Geometry:
    """The same grid described in the transform's voxel order. The origin moves to the new first voxel."""
    directions = np.array([
        -geometry.directions[native] if flipped else geometry.directions[native]
        for native, flipped in zip(transform.perm, transform.flip)
    ])
    origin = geometry.origin.copy()
    for native, flipped in zip(transform.perm, transform.flip):
        if flipped:
            origin += (geometry.dims[native] - 1) * geometry.directions[native]
    dims = tuple(geometry.dims[native] for native in transform.perm)
    return Geometry(dims=dims, directions=directions, origin=origin)


def reorient_view(native: np.ndarray, transform: Transform) -> np.ndarray:
    """`native` seen in the transform's voxel order, as a writeable view: writes land in `native`."""
    view = np.transpose(native, transform.perm)
    for axis, flipped in enumerate(transform.flip):
        if flipped:
            view = np.flip(view, axis=axis)
    return view


def reorient(native: np.ndarray, transform: Transform) -> np.ndarray:
    """A copy of `native` in the transform's voxel order."""
    return np.array(reorient_view(native, transform), copy=True)


def to_native(reoriented: np.ndarray, transform: Transform) -> np.ndarray:
    """A copy of `reoriented` back in the native voxel order: undoes `reorient`."""
    view = reoriented
    for axis, flipped in enumerate(transform.flip):
        if flipped:
            view = np.flip(view, axis=axis)
    return np.array(np.transpose(view, np.argsort(transform.perm)), copy=True)


def ras_affine(geometry: Geometry) -> np.ndarray:
    """The NIfTI (RAS) affine of a grid: x and y negate between LPS and RAS. Both are voxel-centred."""
    affine = np.eye(4)
    affine[:3, :3] = geometry.directions.T * _RAS_FROM_LPS[:, None]
    affine[:3, 3] = geometry.origin * _RAS_FROM_LPS
    return affine


def same_grid(a: Geometry, b: Geometry) -> list[GridMismatch]:
    """How two grids differ beyond storage rounding. An empty list means the same grid."""
    mismatches = []
    if a.dims != b.dims:
        mismatches.append(GridMismatch("dims", a.dims, b.dims))
    if np.max(np.abs(a.spacing - b.spacing)) > SPACING_TOL_MM:
        mismatches.append(GridMismatch("spacing", a.spacing.tolist(), b.spacing.tolist()))
    units_a = a.directions / a.spacing[:, None]
    units_b = b.directions / b.spacing[:, None]
    if np.max(np.abs(units_a - units_b)) > DIRECTION_TOL:
        mismatches.append(GridMismatch("direction", units_a.tolist(), units_b.tolist()))
    if np.max(np.abs(a.origin - b.origin)) > ORIGIN_TOL_MM:
        mismatches.append(GridMismatch("origin", a.origin.tolist(), b.origin.tolist()))
    return mismatches


def describe_mismatches(mismatches: list[GridMismatch]) -> str:
    return "; ".join(f"{m.field}: {m.a} vs {m.b}" for m in mismatches)


class PreviewUnavailable(Exception):
    """No single plane of the file is a canonical axial plane: its slices are not axial."""


def header_summary(parsed: dict) -> dict:
    """The geometry fields of a `/headers` image entry, for the canonical grid, plus the transform
    the file's voxels need. `parsed` is `nrrd_header.parse_nrrd_header`'s dict. Raises
    OrientationError for an image without a patient orientation."""
    native = nrrd_geometry(parsed)
    transform = canonical_transform(native)
    geometry = reoriented_geometry(native, transform)
    return {
        "dimensions": list(geometry.dims),
        "spacing": geometry.spacing.tolist(),
        "space": "left-posterior-superior",
        "space_origin": geometry.origin.tolist(),
        "space_directions": geometry.directions.tolist(),
        "transform": {
            "perm": list(transform.perm),
            "flip": list(transform.flip),
            "obliquity_deg": list(transform.obliquity_deg),
        },
    }


def native_slice_index(transform: Transform, native_dims, k: int) -> int:
    """The file's own z-plane that holds canonical axial plane `k`.

    Only defined when the file's k axis is the canonical k axis. Otherwise every canonical axial
    plane is spread across all of the file's planes, and PreviewUnavailable is raised.
    """
    if transform.perm[2] != 2:
        raise PreviewUnavailable("the file's slices are not axial, so no single file plane is an axial plane")
    nz = int(native_dims[2])
    if not 0 <= k < nz:
        raise IndexError(f"z index {k} out of range [0, {nz})")
    return nz - 1 - k if transform.flip[2] else k


def canonical_plane(plane: bytes, itemsize: int, native_dims, transform: Transform) -> bytes:
    """A file z-plane (i fastest, as NRRD stores it) rewritten as the canonical axial plane (i
    fastest). Voxels move as opaque items of `itemsize` bytes, so byte order needs no knowledge.
    Use with `native_slice_index`, whose transform keeps k as the slice axis."""
    nx, ny = int(native_dims[0]), int(native_dims[1])
    native = np.frombuffer(plane, dtype=np.dtype(f"V{itemsize}")).reshape((ny, nx)).T[:, :, None]
    in_plane = Transform(
        perm=(transform.perm[0], transform.perm[1], 2),
        flip=(transform.flip[0], transform.flip[1], False),
        obliquity_deg=transform.obliquity_deg,
    )
    return np.ascontiguousarray(reorient_view(native, in_plane)[:, :, 0].T).tobytes()


def view_labels(axis: str, geometry: Geometry) -> dict[str, str]:
    """The orientation letters at each screen edge of a view of a canonical grid."""
    right_step, down_step = _VIEW_LAYOUT[axis]
    units = geometry.directions / geometry.spacing[:, None]
    right = np.asarray(right_step, dtype=float) @ units
    down = np.asarray(down_step, dtype=float) @ units
    return {"left": _letters(-right), "right": _letters(right), "top": _letters(-down), "bottom": _letters(down)}


def _letters(direction: np.ndarray) -> str:
    axes = sorted((a for a in range(3) if abs(direction[a]) > LABEL_TOL), key=lambda a: -abs(direction[a]))
    return "".join(("LPS" if direction[a] > 0 else "RAI")[a] for a in axes)


def _parse_codes(codes: str) -> list[tuple[int, int]]:
    if not isinstance(codes, str) or len(codes) != 3 or any(letter not in _LETTERS for letter in codes):
        raise ValueError(f"not a three-letter orientation code: {codes!r}")
    target = [_LETTERS[letter] for letter in codes]
    if sorted(axis for axis, _ in target) != [0, 1, 2]:
        raise ValueError(f"orientation code {codes!r} names a patient axis twice")
    return target


def _from_ras(dims, affine) -> Geometry:
    affine = np.asarray(affine, dtype=float)
    return Geometry(dims=dims, directions=(affine[:3, :3] * _RAS_FROM_LPS[:, None]).T,
                    origin=affine[:3, 3] * _RAS_FROM_LPS)


def _checked(geometry: Geometry) -> Geometry:
    if not (np.all(np.isfinite(geometry.directions)) and np.all(np.isfinite(geometry.origin))):
        raise OrientationError("degenerate", "the geometry contains non-finite values")
    if np.any(geometry.spacing <= 1e-12) or any(n < 1 for n in geometry.dims):
        raise OrientationError(
            "degenerate", f"a voxel axis has no extent (dims {list(geometry.dims)}, spacing {geometry.spacing.tolist()})"
        )
    return geometry
