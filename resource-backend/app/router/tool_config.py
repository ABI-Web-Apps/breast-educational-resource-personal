"""POST /api/tool-config: validate the config, resolve the dataset, stream the outcome."""

import json
import logging
from typing import Iterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from app.models.api_models import ToolConfigRequest
from app.services.assay_registry import ResolvedAssay, registry
from app.services.minio_service import MinIOService, MinIOValidationError, build_sample_type_routes
from app.utils.setup import Config

logger = logging.getLogger(__name__)

router = APIRouter()


def get_minio_service() -> MinIOService:
    return MinIOService()


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _bad_request(e: MinIOValidationError) -> HTTPException:
    logger.warning("tool-config rejected at step %s: %s", e.step, e.summary)
    return HTTPException(status_code=400, detail={"step": e.step, "summary": e.summary, "detail": e.detail})


def _resolve(request: ToolConfigRequest, service: MinIOService) -> dict:
    """Blocking: validate the config and resolve every cohort's inputs against MinIO."""
    base_url = request.system.minio.base_url
    service.validate_base_url(base_url)
    routes = build_sample_type_routes(request.assay_info.datasets, Config.INPUTS)
    return service.validate_and_resolve_inputs(
        public_path=base_url,
        datasets=request.assay_info.datasets,
        cohorts=request.assay_info.cohorts,
        routes=routes,
    )


@router.post("/api/tool-config")
async def post_tool_config(request: ToolConfigRequest, service: MinIOService = Depends(get_minio_service)):
    assay = request.assay_info
    logger.info("tool-config: user=%s assay=%s cohorts=%s", request.user_info.uuid, assay.uuid, assay.cohorts)

    try:
        resolved = await run_in_threadpool(_resolve, request, service)
    except MinIOValidationError as e:
        raise _bad_request(e)
    except Exception as e:
        logger.exception("tool-config: unexpected validation failure")
        raise HTTPException(
            status_code=400,
            detail={"step": "unknown", "summary": f"Unexpected validation error: {e}", "detail": str(e)},
        )

    cohorts = list(assay.cohorts)

    def stream() -> Iterator[str]:
        try:
            registry.put(ResolvedAssay(uuid=assay.uuid, base_url=request.system.minio.base_url, cohorts=resolved))
            total = len(cohorts)
            for index, cohort in enumerate(cohorts, start=1):
                yield sse_event("progress", {"step": "resolve", "case": cohort, "current": index, "total_cases": total})
                inputs = {sample_type: url is not None for sample_type, url in resolved[cohort].items()}
                yield sse_event("resolved", {"case": cohort, "inputs": inputs})
            yield sse_event("complete", {"assay": assay.uuid, "cases": cohorts})
        except Exception as e:
            logger.exception("tool-config: failure while streaming")
            yield sse_event("error", {"step": "resolve", "summary": f"Unexpected error: {e}", "detail": str(e)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
