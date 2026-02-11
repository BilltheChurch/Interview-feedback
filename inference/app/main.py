from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.exceptions import (
    AudioDecodeError,
    NotImplementedServiceError,
    PayloadTooLargeError,
    SVBackendError,
    UnauthorizedError,
    ValidationError,
)
from app.runtime import build_runtime
from app.schemas import (
    DiarizeRequest,
    DiarizeResponse,
    ErrorResponse,
    ExtractEmbeddingRequest,
    ExtractEmbeddingResponse,
    HealthResponse,
    ResolveRequest,
    ResolveResponse,
    ScoreRequest,
    ScoreResponse,
)

settings = get_settings()
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
logger = logging.getLogger(__name__)

runtime = build_runtime(settings)
app = FastAPI(title=settings.app_name, version="0.1.0")


@app.middleware("http")
async def api_key_guard(request: Request, call_next):
    if settings.inference_api_key:
        incoming_key = request.headers.get("x-api-key", "")
        if incoming_key != settings.inference_api_key:
            raise UnauthorizedError("invalid x-api-key")
    return await call_next(request)


@app.exception_handler(AudioDecodeError)
async def handle_audio_decode_error(_: Request, exc: AudioDecodeError) -> JSONResponse:
    return JSONResponse(status_code=400, content=ErrorResponse(detail=str(exc)).model_dump())


@app.exception_handler(UnauthorizedError)
async def handle_auth_error(_: Request, exc: UnauthorizedError) -> JSONResponse:
    return JSONResponse(status_code=401, content=ErrorResponse(detail=str(exc)).model_dump())


@app.exception_handler(PayloadTooLargeError)
async def handle_payload_too_large(_: Request, exc: PayloadTooLargeError) -> JSONResponse:
    return JSONResponse(status_code=413, content=ErrorResponse(detail=str(exc)).model_dump())


@app.exception_handler(ValidationError)
async def handle_validation_error(_: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content=ErrorResponse(detail=str(exc)).model_dump())


@app.exception_handler(NotImplementedServiceError)
async def handle_not_implemented(_: Request, exc: NotImplementedServiceError) -> JSONResponse:
    return JSONResponse(status_code=501, content=ErrorResponse(detail=str(exc)).model_dump())


@app.exception_handler(SVBackendError)
async def handle_sv_backend_error(_: Request, exc: SVBackendError) -> JSONResponse:
    logger.exception("speaker verification backend error")
    return JSONResponse(status_code=500, content=ErrorResponse(detail=str(exc)).model_dump())


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    sv_health = runtime.sv_backend.health()
    return HealthResponse(
        app_name=settings.app_name,
        model_id=sv_health.model_id,
        model_revision=sv_health.model_revision,
        embedding_dim=sv_health.embedding_dim,
        sv_t_low=settings.sv_t_low,
        sv_t_high=settings.sv_t_high,
        segmenter_backend=settings.segmenter_backend,
        diarization_enabled=settings.enable_diarization,
    )


@app.post("/sv/extract_embedding", response_model=ExtractEmbeddingResponse)
async def extract_embedding(req: ExtractEmbeddingRequest) -> ExtractEmbeddingResponse:
    embedding = runtime.orchestrator.extract_embedding(req.audio)
    return ExtractEmbeddingResponse(
        model_id=settings.sv_model_id,
        model_revision=settings.sv_model_revision,
        embedding_dim=int(embedding.size),
        embedding=embedding.astype(float).tolist(),
    )


@app.post("/sv/score", response_model=ScoreResponse)
async def score(req: ScoreRequest) -> ScoreResponse:
    score_value = runtime.orchestrator.score(req.audio_a, req.audio_b)
    return ScoreResponse(
        model_id=settings.sv_model_id,
        model_revision=settings.sv_model_revision,
        score=score_value,
    )


@app.post("/speaker/resolve", response_model=ResolveResponse)
async def resolve_speaker(req: ResolveRequest) -> ResolveResponse:
    return runtime.orchestrator.resolve(
        session_id=req.session_id,
        audio_payload=req.audio,
        asr_text=req.asr_text,
        state=req.state,
    )


@app.post("/sd/diarize", response_model=DiarizeResponse)
async def diarize(req: DiarizeRequest) -> DiarizeResponse:
    raise NotImplementedServiceError("/sd/diarize is reserved for Phase 2 diarization plugin")


@app.exception_handler(HTTPException)
async def handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=ErrorResponse(detail=str(exc.detail)).model_dump())


@app.exception_handler(Exception)
async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("unexpected error")
    return JSONResponse(status_code=500, content=ErrorResponse(detail=f"internal server error: {exc}").model_dump())
