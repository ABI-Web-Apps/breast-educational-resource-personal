"""Request models for the tool-config endpoint. Unknown keys are ignored."""

from typing import Any, List

from pydantic import BaseModel, field_validator, model_validator


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


def _rename_keys(data: Any, aliases: dict[str, str]) -> Any:
    """Map accepted alternative key spellings onto the canonical field name.

    Done in a before-validator rather than with `validation_alias`: FastAPI re-wraps a model's
    field metadata when it builds the request body, and pydantic ignores (with a warning) an
    alias attached that way, so the alternative spellings would silently stop working.
    A canonical key present in the payload wins over an alternative one.
    """
    if not isinstance(data, dict):
        return data
    renamed = dict(data)
    for alias, name in aliases.items():
        if alias in renamed:
            value = renamed.pop(alias)
            renamed.setdefault(name, value)
    return renamed


class MinioSystemInfo(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def _accept_aliases(cls, data: Any) -> Any:
        return _rename_keys(data, {"public_path": "base_url"})

    base_url: str


class SystemInfo(BaseModel):
    minio: MinioSystemInfo


class ToolConfigRequest(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def _accept_aliases(cls, data: Any) -> Any:
        return _rename_keys(
            data,
            {
                "user-info": "user_info",
                "userInfo": "user_info",
                "assay-info": "assay_info",
                "assayInfo": "assay_info",
            },
        )

    user_info: UserInfo
    assay_info: AssayInfo
    system: SystemInfo
