"""Mask NIfTI -> GLB mesh, one coloured mesh per label, vertices in patient LPS millimetres.

Marching cubes runs on the mask in the canonical order (i -> L, j -> P, k -> S) and each vertex
is mapped through the canonical grid,

    p = origin + index . D        (D's rows: one voxel step along each canonical axis, in LPS mm)

whatever voxel order the file stores, so the mesh lands on the same voxels as the slice planes.
Everything happens in memory.
"""

import logging
import re

import numpy as np
import trimesh
from skimage.measure import marching_cubes
from trimesh.visual.material import PBRMaterial

from app.services.volume_reader import read_canonical

logger = logging.getLogger(__name__)

NEUTRAL_COLOR = "#94a3b8"

#: Bump when the meshing changes, so cached GLBs from the old code are not served.
MESH_VERSION = "v1"

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class MaskUnreadable(ValueError):
    """The bytes are not a mask that can be read in the canonical order."""


def mesh_in_patient_space(verts_index, normals_index, directions, origin):
    """Marching-cubes output in canonical index space, as patient LPS millimetres.

    Vertices go through the grid (`origin + index . D`). Normals go through the inverse
    transpose, so they stay perpendicular to the surface on an anisotropic or tilted grid.
    """
    directions = np.asarray(directions, dtype=float)
    verts = np.asarray(origin, dtype=float) + np.asarray(verts_index, dtype=float) @ directions
    normals = np.asarray(normals_index, dtype=float) @ np.linalg.inv(directions).T
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    return verts, normals / np.where(lengths > 0, lengths, 1.0)


def _rgb(color) -> list[int]:
    """`[r, g, b]` for a `#rrggbb` string; anything else (None, `#fff`, `red`) is neutral grey."""
    if not isinstance(color, str) or not _HEX_COLOR.match(color):
        color = NEUTRAL_COLOR
    text = color.lstrip("#")
    return [int(text[i : i + 2], 16) for i in (0, 2, 4)]


def mask_to_glb(nii_bytes: bytes, channel_colors: dict[int, str]) -> bytes | None:
    """A GLB with one node `channel_<label>` per label present, or None for an empty mask.

    `channel_colors` maps a label to `#rrggbb`; a label without an entry gets neutral grey.
    Raises `MaskUnreadable` when the bytes cannot be read as a mask.
    """
    read = read_canonical(nii_bytes, "mask.nii")
    if read is None:
        raise MaskUnreadable("the mask could not be read in the canonical order")
    voxels, grid = read
    data = np.rint(voxels).astype(np.uint8)

    scene = trimesh.Scene()
    for label in (int(v) for v in np.unique(data) if v != 0):
        channel = (data == label).astype(np.uint8) * 255
        try:
            verts_index, faces, normals_index, _ = marching_cubes(channel, level=127)
        except RuntimeError as exc:
            logger.warning("label %s has no surface: %s", label, exc)
            continue
        verts, normals = mesh_in_patient_space(verts_index, normals_index, grid.directions, grid.origin)
        rgb = _rgb(channel_colors.get(label, NEUTRAL_COLOR))
        item = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals, process=False)
        item.visual.material = PBRMaterial(
            baseColorFactor=[c / 255.0 for c in rgb] + [1.0],
            metallicFactor=0.0,
            roughnessFactor=0.4,
            doubleSided=True,
        )
        item.visual.face_colors = np.tile(rgb, (len(faces), 1))
        # Named by label, not position: labels 1, 10 and 11 must stay distinguishable.
        scene.add_geometry(item, node_name=f"channel_{label}")

    if not scene.geometry:
        return None
    return scene.export(file_type="glb")
