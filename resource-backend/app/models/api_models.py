"""Request models for the tool-config endpoint. Unknown keys are ignored."""

from typing import List

from pydantic import AliasChoices, BaseModel, Field, field_validator


def _clean_names(values: List[str]) -> List[str]:
    """Trim, drop blanks and de-duplicate a list of names, keeping input order.

    Every downstream use (subjects.xlsx lookup, the samples.xlsx "Sample Type" column) is an
    exact match, so stray whitespace from a free-text field is normalised once here.
    """
    cleaned: List[str] = []
    for v in values:
        name = v.strip()
        if name and name not in cleaned:
            cleaned.append(name)
    return cleaned


class UserInfo(BaseModel):
    uuid: str


class DatasetSpec(BaseModel):
    """One dataset and the sample types it is the source of truth for.

    The list is a routing declaration, not a filter: a sample type named here is resolved
    from THIS dataset and no other.
    """

    name: str
    sample_type: List[str]

    @field_validator("name")
    @classmethod
    def _normalise_name(cls, v: str) -> str:
        name = v.strip()
        if not name:
            raise ValueError("dataset name must not be blank")
        return name

    @field_validator("sample_type")
    @classmethod
    def _normalise_sample_types(cls, v: List[str]) -> List[str]:
        cleaned = _clean_names(v)
        if not cleaned:
            raise ValueError("a dataset must declare at least one sample_type")
        return cleaned


class AssayInfo(BaseModel):
    uuid: str
    name: str
    cohorts: List[str]
    datasets: List[DatasetSpec]

    @field_validator("cohorts")
    @classmethod
    def _normalise_cohorts(cls, v: List[str]) -> List[str]:
        return _clean_names(v)


class MinioSystemInfo(BaseModel):
    base_url: str = Field(..., validation_alias=AliasChoices("base_url", "public_path"))


class SystemInfo(BaseModel):
    minio: MinioSystemInfo


class ToolConfigRequest(BaseModel):
    user_info: UserInfo = Field(..., validation_alias=AliasChoices("user_info", "user-info", "userInfo"))
    assay_info: AssayInfo = Field(..., validation_alias=AliasChoices("assay_info", "assay-info", "assayInfo"))
    system: SystemInfo
