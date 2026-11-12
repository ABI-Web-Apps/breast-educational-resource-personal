"""Per-patient reads: the contrast-1 MRI volume and the findings record."""

import gzip
import logging
import re
import threading
import zlib
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from minio.error import S3Error
from pydantic import ValidationError

from app.reports import schema
from app.router.tool_config import get_minio_service
from app.services.assay_registry import registry
from app.services.minio_service import MinIOService
from app.services.nrrd_header import NrrdHeaderError, parse_nrrd_header, split_header

logger = logging.getLogger(__name__)

router = APIRouter()

MRI_SAMPLE_TYPE = "contrast_1_nrrd"
FINDINGS_SAMPLE_TYPE = "findings_json"

#: Encoded volumes kept in memory, keyed by the source object's identity. Two entries bound the
#: footprint to a pair of compressed volumes; nothing is ever written to disk.
_MRI_CACHE_SIZE = 2
_mri_cache: "OrderedDict[str, bytes]" = OrderedDict()
_mri_cache_lock = threading.Lock()

_GZIP_MAGIC = b"\x1f\x8b"
_ENCODING_LINE = re.compile(rb"^encoding:[ \t]*.*$", re.IGNORECASE | re.MULTILINE)


def clear_mri_cache() -> None:
    with _mri_cache_lock:
        _mri_cache.clear()


def _error(status: int, code: str, summary: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "summary": summary})


def resolved_input(assay_uuid: str, cohort: str, sample_type: str) -> str | None:
    """The object URL of a cohort's input, or None when the cohort has no such sample."""
    assay = registry.get(assay_uuid)
    if assay is None:
        raise _error(409, "assay_not_loaded", f"Assay {assay_uuid} has not been configured; post its tool config first.")
    inputs = assay.cohorts.get(cohort)
    if inputs is None:
        raise _error(404, "unknown_cohort", f"Cohort {cohort} is not part of assay {assay_uuid}.")
    return inputs.get(sample_type)


def to_gzip_nrrd(raw: bytes) -> bytes:
    """An NRRD with `encoding: gzip`. A gzip-encoded source is returned unchanged.

    A raw source has its data block gzipped and its encoding line rewritten; the voxels are
    treated as opaque bytes and never decoded.
    """
    if raw.startswith(_GZIP_MAGIC):
        raw = gzip.decompress(raw)
    header_text, offset = split_header(raw)
    encoding = parse_nrrd_header(header_text)["encoding"]
    if encoding in ("gzip", "gz"):
        return raw
    if encoding != "raw":
        raise NrrdHeaderError(f"unsupported NRRD encoding: {encoding!r}")
    header = _ENCODING_LINE.sub(b"encoding: gzip", header_text, count=1)
    return header + b"\n\n" + gzip.compress(raw[offset:], compresslevel=6, mtime=0)


def _encoded_mri(service: MinIOService, url: str) -> bytes:
    try:
        identity = service.object_identity(url)
    except S3Error as e:
        logger.warning("could not stat MRI %s: %s", url, e)
        raise _error(404, "no_mri", "The MRI volume could not be read.") from e
    with _mri_cache_lock:
        cached = _mri_cache.get(identity)
        if cached is not None:
            _mri_cache.move_to_end(identity)
            return cached

    raw = service.read_object_bytes(url)
    if raw is None:
        raise _error(404, "no_mri", "The MRI volume could not be read.")
    try:
        encoded = to_gzip_nrrd(raw)
    except (NrrdHeaderError, OSError, EOFError, zlib.error) as e:
        logger.warning("MRI %s is not a usable NRRD: %s", url, e)
        raise _error(422, "invalid_mri", f"The MRI volume is not a readable NRRD: {e}") from e

    with _mri_cache_lock:
        _mri_cache[identity] = encoded
        _mri_cache.move_to_end(identity)
        while len(_mri_cache) > _MRI_CACHE_SIZE:
            _mri_cache.popitem(last=False)
    return encoded


@router.get("/api/patients/{assay_uuid}/{cohort}/mri")
def get_mri(assay_uuid: str, cohort: str, service: MinIOService = Depends(get_minio_service)):
    url = resolved_input(assay_uuid, cohort, MRI_SAMPLE_TYPE)
    if url is None:
        raise _error(404, "no_mri", f"Cohort {cohort} has no MRI volume.")
    return Response(content=_encoded_mri(service, url), media_type="application/octet-stream")


@router.get("/api/patients/{assay_uuid}/{cohort}/findings")
def get_findings(assay_uuid: str, cohort: str, service: MinIOService = Depends(get_minio_service)):
    url = resolved_input(assay_uuid, cohort, FINDINGS_SAMPLE_TYPE)
    raw = service.read_object_bytes(url) if url else None
    if raw is None:
        raise _error(404, "no_findings", f"Cohort {cohort} has no findings record.")
    try:
        record = schema.loads(raw)
    except ValidationError as e:
        logger.warning("findings for %s do not match the schema: %s", cohort, e)
        raise _error(422, "invalid_findings", "The findings record does not match the expected schema.")
    return Response(content=schema.dumps(record), media_type="application/json")
