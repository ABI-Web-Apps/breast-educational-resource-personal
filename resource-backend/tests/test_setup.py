from app.utils.setup import BACKEND_ROOT, Config


def test_inputs_are_the_three_sample_types():
    assert Config.INPUTS == ["contrast_1_nrrd", "researcher_manual_LPS_nii", "findings_json"]


def test_outputs_are_empty():
    assert Config.OUTPUTS == []


def test_workdir_is_not_shipped():
    assert "static/workdir/" in (BACKEND_ROOT / ".dockerignore").read_text()


def test_fixture_dataset_has_metadata(sparc_dataset):
    assert {p.name for p in sparc_dataset.glob("*.xlsx")} >= {
        "subjects.xlsx",
        "samples.xlsx",
        "manifest.xlsx",
    }
