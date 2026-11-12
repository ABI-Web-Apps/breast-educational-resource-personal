"""Shared test fixtures."""

import json
from pathlib import Path

import nibabel as nib
import numpy as np
import nrrd
import pandas as pd
import pytest

GRID = (12, 10, 6)
SPACING = (0.885, 0.885, 1.5)
ORIGIN_LPS = (-175.5, -159.9, -84.4)

# (subject, sample id, sample type, file name). File names deliberately do not
# match the sample type: the dataset is read through samples.xlsx, not by name.
_SAMPLES = [
    ("sub-1", "sam-1", "contrast_1_nrrd", "c1.nrrd"),
    ("sub-1", "sam-2", "researcher_manual_LPS_nii", "m.nii.gz"),
    ("sub-1", "sam-3", "findings_json", "f.json"),
    ("sub-2", "sam-1", "contrast_1_nrrd", "c1.nrrd"),
    ("sub-2", "sam-2", "researcher_manual_LPS_nii", "m.nii.gz"),
]


def _findings() -> dict:
    def finding(n: int, color: str) -> dict:
        return {
            "id": f"f_{n}",
            "label": f"Finding {n}",
            "lesion": {"layer_id": f"layer{n}", "channel": n, "color": color},
            "kinetics": {
                "early_phase": "medium",
                "delayed_phase": "persistent",
                "curve": {
                    "phases": ["contrast_pre", "contrast_1"],
                    "mean_intensity": [420.6, 782.3],
                    "percent_change": [0.0, 86.0],
                },
                "source": "computed",
            },
            "location": {
                "laterality": None,
                "clock_position": None,
                "quadrant": None,
                "depth": None,
                "distance_nipple_cm": None,
                "distance_skin_cm": None,
                "distance_ribcage_cm": None,
            },
            "size": {
                "max_linear_mm": None,
                "ap_mm": None,
                "transverse_mm": None,
                "craniocaudal_mm": None,
                "volume_mm3": None,
            },
            "assessment": None,
            "provenance": {"mask_edited": False, "mask_edited_at": None},
        }

    return {
        "schema_version": 2,
        "updated_at": "2026-08-10T00:00:00Z",
        "breast_tissue": {"fgt": None, "bpe_level": None, "bpe_symmetry": None},
        "findings": [finding(1, "#ff7043"), finding(2, "#42a5f5")],
        "assessment": {"category": None, "source": "derived"},
    }


def _write_nrrd(path: Path) -> None:
    data = (np.arange(np.prod(GRID), dtype=np.uint16) % 997).reshape(GRID)
    header = {
        "space": "left-posterior-superior",
        "space directions": np.diag(SPACING),
        "space origin": np.array(ORIGIN_LPS),
        "kinds": ["domain", "domain", "domain"],
        "encoding": "gzip",
    }
    nrrd.write(str(path), data, header)


def _write_mask(path: Path) -> None:
    mask = np.zeros(GRID, dtype=np.uint8)
    mask[2:5, 2:5, 1:3] = 1  # label 1: a 3x3x2 block
    mask[8, 6, 4] = 2  # label 2: a single voxel
    # The NRRD is on an LPS grid; NIfTI is RAS, so x and y flip sign.
    affine = np.diag([-SPACING[0], -SPACING[1], SPACING[2], 1.0])
    affine[:3, 3] = (-ORIGIN_LPS[0], -ORIGIN_LPS[1], ORIGIN_LPS[2])
    nib.save(nib.Nifti1Image(mask, affine), str(path))


@pytest.fixture()
def sparc_dataset(tmp_path) -> Path:
    """A tiny SPARC dataset folder (`workdir`): sub-1 with findings, sub-2 without."""
    root = tmp_path / "workdir"
    rows = []
    for subject, sample, sample_type, name in _SAMPLES:
        folder = root / "primary" / subject / sample
        folder.mkdir(parents=True)
        path = folder / name
        if sample_type == "contrast_1_nrrd":
            _write_nrrd(path)
        elif sample_type == "researcher_manual_LPS_nii":
            _write_mask(path)
        else:
            path.write_text(json.dumps(_findings()))
        rows.append((subject, sample, sample_type, f"primary/{subject}/{sample}/{name}"))

    pd.DataFrame({"subject id": ["sub-1", "sub-2"]}).to_excel(root / "subjects.xlsx", index=False)
    pd.DataFrame(
        {
            "sample id": [r[1] for r in rows],
            "subject id": [r[0] for r in rows],
            "sample type": [r[2] for r in rows],
        }
    ).to_excel(root / "samples.xlsx", index=False)
    pd.DataFrame(
        {
            "filename": [r[3] for r in rows],
            "timestamp": "2026-09-03 01:34:10",
            "description": [f"File of subject {r[0]} sample {r[1]}" for r in rows],
            "file type": [Path(r[3]).suffix for r in rows],
        }
    ).to_excel(root / "manifest.xlsx", index=False)
    return root
