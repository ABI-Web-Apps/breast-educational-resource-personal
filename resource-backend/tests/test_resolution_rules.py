"""Which file a sample resolves to, and when resolution refuses instead of guessing.

`fetch_excel` is the only network call on this path, so patching it makes the resolver
testable from small DataFrames.
"""

import pandas as pd
import pytest

from app.models.api_models import DatasetSpec
from app.services.minio_service import MinIOService, MinIOValidationError

BASE = "http://minio:9000/measurements/"
CONTRAST = "contrast_1_nrrd"
MASK = "researcher_manual_LPS_nii"


def _samples(*rows):
    """rows: (subject_id, sample_type, sample_id)"""
    return pd.DataFrame(list(rows), columns=["Subject ID", "Sample Type", "Sample ID"])


def _resolve(monkeypatch, samples, *filenames, types=(CONTRAST, MASK), subjects=None, manifest=None):
    tables = {
        "subjects.xlsx": subjects if subjects is not None else pd.DataFrame({"Subject ID": ["sub-1"]}),
        "samples.xlsx": samples,
        "manifest.xlsx": manifest if manifest is not None else pd.DataFrame({"filename": list(filenames)}),
    }
    monkeypatch.setattr(MinIOService, "fetch_excel", lambda self, url: tables[url.rsplit("/", 1)[-1]])
    return MinIOService(client=object()).validate_and_resolve_inputs(
        public_path=BASE,
        datasets=[DatasetSpec(name="workdir", sample_type=list(types))],
        cohorts=["sub-1"],
        routes={t: "workdir" for t in types},
    )["sub-1"]


TWO_SAMPLES = _samples(("sub-1", CONTRAST, "sam-1"), ("sub-1", MASK, "sam-10"))


@pytest.mark.parametrize("sam10_first", [False, True])
def test_sample_resolves_to_its_own_folder_whatever_the_manifest_order(monkeypatch, sam10_first):
    files = ["primary/sub-1/sam-1/c.nrrd", "primary/sub-1/sam-10/m.nii.gz"]
    if sam10_first:
        files.reverse()
    resolved = _resolve(monkeypatch, TWO_SAMPLES, *files)
    assert resolved[CONTRAST] == BASE + "workdir/primary/sub-1/sam-1/c.nrrd"
    assert resolved[MASK] == BASE + "workdir/primary/sub-1/sam-10/m.nii.gz"


def test_sample_without_a_file_does_not_borrow_a_longer_ids_file(monkeypatch):
    resolved = _resolve(monkeypatch, TWO_SAMPLES, "primary/sub-1/sam-10/m.nii.gz")
    assert resolved[CONTRAST] is None
    assert resolved[MASK] == BASE + "workdir/primary/sub-1/sam-10/m.nii.gz"


def test_prefixed_filename_still_matches(monkeypatch):
    resolved = _resolve(
        monkeypatch, TWO_SAMPLES, "./primary/sub-1/sam-1/c.nrrd", "primary/sub-1/sam-10/m.nii.gz"
    )
    assert resolved[CONTRAST] == BASE + "workdir/primary/sub-1/sam-1/c.nrrd"


def test_sample_folder_with_two_files_is_refused(monkeypatch):
    with pytest.raises(MinIOValidationError) as exc:
        _resolve(
            monkeypatch, TWO_SAMPLES,
            "primary/sub-1/sam-1/c.nrrd", "primary/sub-1/sam-1/c_old.nrrd",
            "primary/sub-1/sam-10/m.nii.gz",
        )
    assert exc.value.step == "1.4"
    assert "workdir" in exc.value.summary and "sam-1" in exc.value.summary
    assert "c.nrrd" in exc.value.detail and "c_old.nrrd" in exc.value.detail


def test_two_rows_of_one_sample_type_for_a_subject_are_refused(monkeypatch):
    samples = _samples(("sub-1", CONTRAST, "sam-1"), ("sub-1", CONTRAST, "sam-7"))
    with pytest.raises(MinIOValidationError) as exc:
        _resolve(
            monkeypatch, samples,
            "primary/sub-1/sam-1/c.nrrd", "primary/sub-1/sam-7/c.nrrd",
            types=(CONTRAST,),
        )
    assert exc.value.step == "1.4"
    assert CONTRAST in exc.value.summary
    assert "sam-1" in exc.value.summary and "sam-7" in exc.value.summary


def test_samples_sheet_missing_a_column_resolves_to_none(monkeypatch):
    samples = pd.DataFrame({"Subject ID": ["sub-1"], "Sample Type": [CONTRAST]})  # no Sample ID
    resolved = _resolve(monkeypatch, samples, "primary/sub-1/sam-1/c.nrrd", types=(CONTRAST,))
    assert resolved[CONTRAST] is None


def test_manifest_missing_the_filename_column_resolves_to_none(monkeypatch):
    samples = _samples(("sub-1", CONTRAST, "sam-1"))
    resolved = _resolve(
        monkeypatch, samples, types=(CONTRAST,),
        manifest=pd.DataFrame({"path": ["primary/sub-1/sam-1/c.nrrd"]}),
    )
    assert resolved[CONTRAST] is None


def test_subjects_sheet_without_subject_id_is_refused(monkeypatch):
    with pytest.raises(MinIOValidationError) as exc:
        _resolve(
            monkeypatch, _samples(("sub-1", CONTRAST, "sam-1")), "primary/sub-1/sam-1/c.nrrd",
            types=(CONTRAST,), subjects=pd.DataFrame({"Not Subject ID": ["sub-1"]}),
        )
    assert exc.value.step == "1.3"
    assert "Subject ID" in exc.value.summary


def test_cohort_absent_from_subjects_sheet_resolves_to_none(monkeypatch):
    """A dataset that never carried a cohort is a normal state, not an error."""
    resolved = _resolve(
        monkeypatch, _samples(("sub-2", CONTRAST, "sam-1")), "primary/sub-2/sam-1/c.nrrd",
        types=(CONTRAST,),
    )
    assert resolved[CONTRAST] is None
