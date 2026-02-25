from __future__ import annotations

import asyncio
import concurrent.futures
import hmac
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routes.asr import router as asr_router
from app.routes.batch import router as batch_router
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
    CheckpointRequest,
    CheckpointResponse,
    DeviceInfo,
    EnrollRequest,
    EnrollResponse,
    DiarizeRequest,
    DiarizeResponse,
    ErrorResponse,
    ExtractEmbeddingRequest,
    ExtractEmbeddingResponse,
    AnalysisEventsRequest,
    AnalysisEventsResponse,
    AnalysisReportRequest,
    AnalysisReportResponse,
    MergeCheckpointsRequest,
    RegenerateClaimRequest,
    RegenerateClaimResponse,
    HealthResponse,
    ResolveRequest,
    ResolveResponse,
    ScoreRequest,
    ScoreResponse,
    SynthesizeReportRequest,
    ImprovementRequest,
    ImprovementResponse,
)
from app.security import SlidingWindowRateLimiter, extract_client_ip, rate_limit_headers

settings = get_settings()
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
logger = logging.getLogger(__name__)

runtime = build_runtime(settings)
rate_limiter = (
    SlidingWindowRateLimiter(
        requests_per_window=settings.rate_limit_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    if settings.rate_limit_enabled
    else None
)
app = FastAPI(title=settings.app_name, version="0.1.0")
app.include_router(asr_router)
app.include_router(batch_router)

_thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=64)


@app.on_event("startup")
async def _expand_thread_pool() -> None:
    """Expand asyncio thread pool so concurrent SV model calls don't starve other endpoints."""
    asyncio.get_running_loop().set_default_executor(_thread_pool)


@app.on_event("startup")
async def _warmup_whisper() -> None:
    """Pre-load the Whisper model at startup so the first ASR request doesn't block for minutes."""
    try:
        from app.routes.asr import _get_whisper

        logger.info("Warming up Whisper model (this may take a few minutes on first run)...")
        whisper = await asyncio.to_thread(_get_whisper)
        logger.info("Whisper model ready: device=%s, backend=%s", whisper.device, whisper.backend)
    except Exception as exc:
        logger.warning("Whisper warm-up failed (will retry on first request): %s", exc)


@app.middleware("http")
async def request_guard(request: Request, call_next):
    # Skip API key check for health endpoint (Docker health check, load balancers)
    if settings.inference_api_key.get_secret_value() and request.url.path != "/health":
        incoming_key = request.headers.get("x-api-key", "")
        if not hmac.compare_digest(incoming_key.encode(), settings.inference_api_key.get_secret_value().encode()):
            raise UnauthorizedError("invalid x-api-key")

    if request.method in {"POST", "PUT", "PATCH"}:
        content_length = request.headers.get("content-length", "")
        if content_length:
            try:
                if int(content_length) > settings.max_request_body_bytes:
                    raise PayloadTooLargeError(
                        f"request body exceeds MAX_REQUEST_BODY_BYTES={settings.max_request_body_bytes}"
                    )
            except ValueError:
                # Ignore malformed Content-Length and rely on actual body size check below.
                pass

        body = await request.body()
        if len(body) > settings.max_request_body_bytes:
            raise PayloadTooLargeError(
                f"request body exceeds MAX_REQUEST_BODY_BYTES={settings.max_request_body_bytes}"
            )

    decision = None
    if rate_limiter is not None and request.url.path not in {"/health", "/docs", "/openapi.json", "/redoc"}:
        client_key = extract_client_ip(request=request, trust_proxy_headers=settings.trust_proxy_headers)
        decision = rate_limiter.allow(client_key=client_key)
        if not decision.allowed:
            return JSONResponse(
                status_code=429,
                content=ErrorResponse(detail="rate limit exceeded").model_dump(),
                headers=rate_limit_headers(decision),
            )

    response = await call_next(request)
    if decision is not None:
        for key, value in rate_limit_headers(decision).items():
            response.headers[key] = value
    return response


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


@app.get("/health")
async def health():
    """Minimal health check — no auth required."""
    return {"status": "ok", "app_name": settings.app_name}


@app.get("/health/detailed", response_model=HealthResponse)
async def health_detailed() -> HealthResponse:
    """Detailed diagnostics — requires authentication."""
    sv_health = runtime.sv_backend.health()
    return HealthResponse(
        app_name=settings.app_name,
        model_id=sv_health.model_id,
        model_revision=sv_health.model_revision,
        embedding_dim=sv_health.embedding_dim,
        sv_t_low=settings.sv_t_low,
        sv_t_high=settings.sv_t_high,
        max_request_body_bytes=settings.max_request_body_bytes,
        rate_limit_enabled=settings.rate_limit_enabled,
        rate_limit_requests=settings.rate_limit_requests,
        rate_limit_window_seconds=settings.rate_limit_window_seconds,
        segmenter_backend=settings.segmenter_backend,
        diarization_enabled=settings.enable_diarization,
        devices=DeviceInfo(
            sv_device=sv_health.device,
            whisper_device=settings.whisper_device,
            pyannote_device=settings.pyannote_device,
            whisper_model_size=settings.whisper_model_size,
        ),
    )


@app.post("/sv/extract_embedding", response_model=ExtractEmbeddingResponse)
async def extract_embedding(req: ExtractEmbeddingRequest) -> ExtractEmbeddingResponse:
    embedding = await asyncio.to_thread(runtime.orchestrator.extract_embedding, req.audio)
    return ExtractEmbeddingResponse(
        model_id=settings.sv_model_id,
        model_revision=settings.sv_model_revision,
        embedding_dim=int(embedding.size),
        embedding=embedding.astype(float).tolist(),
    )


@app.post("/sv/score", response_model=ScoreResponse)
async def score(req: ScoreRequest) -> ScoreResponse:
    score_value = await asyncio.to_thread(runtime.orchestrator.score, req.audio_a, req.audio_b)
    return ScoreResponse(
        model_id=settings.sv_model_id,
        model_revision=settings.sv_model_revision,
        score=score_value,
    )


@app.post("/speaker/resolve", response_model=ResolveResponse)
async def resolve_speaker(req: ResolveRequest) -> ResolveResponse:
    return await asyncio.to_thread(
        runtime.orchestrator.resolve,
        session_id=req.session_id,
        audio_payload=req.audio,
        asr_text=req.asr_text,
        state=req.state,
    )


@app.post("/speaker/enroll", response_model=EnrollResponse)
async def enroll_speaker(req: EnrollRequest) -> EnrollResponse:
    return await asyncio.to_thread(
        runtime.orchestrator.enroll,
        session_id=req.session_id,
        participant_name=req.participant_name,
        audio_payload=req.audio,
        state=req.state,
    )


@app.post("/analysis/events", response_model=AnalysisEventsResponse)
async def analyze_events(req: AnalysisEventsRequest) -> AnalysisEventsResponse:
    # Run inline — events analyzer is pure CPU keyword matching (<1ms),
    # no I/O.  Avoids thread-pool starvation when SV model calls fill the pool.
    events = runtime.events_analyzer.analyze(
        session_id=req.session_id,
        transcript=req.transcript,
        memos=req.memos,
        stats=req.stats,
    )
    return AnalysisEventsResponse(session_id=req.session_id, events=events)


@app.post("/analysis/report", response_model=AnalysisReportResponse)
async def analyze_report(req: AnalysisReportRequest) -> AnalysisReportResponse:
    return await asyncio.to_thread(runtime.report_generator.generate, req)


@app.post("/analysis/regenerate-claim", response_model=RegenerateClaimResponse)
async def regenerate_claim(req: RegenerateClaimRequest) -> RegenerateClaimResponse:
    return await asyncio.to_thread(runtime.report_generator.regenerate_claim, req)


@app.post("/analysis/synthesize", response_model=AnalysisReportResponse)
async def synthesize_report(req: SynthesizeReportRequest) -> AnalysisReportResponse:
    return await asyncio.to_thread(runtime.report_synthesizer.synthesize, req)


@app.post("/analysis/improvements", response_model=ImprovementResponse)
async def generate_improvements(req: ImprovementRequest) -> ImprovementResponse:
    return await asyncio.to_thread(runtime.improvement_generator.generate, req)


@app.post("/analysis/checkpoint", response_model=CheckpointResponse)
async def analyze_checkpoint(req: CheckpointRequest) -> CheckpointResponse:
    return await asyncio.to_thread(runtime.checkpoint_analyzer.analyze_checkpoint, req)


@app.post("/analysis/merge-checkpoints", response_model=AnalysisReportResponse)
async def merge_checkpoints(req: MergeCheckpointsRequest) -> AnalysisReportResponse:
    return await asyncio.to_thread(runtime.checkpoint_analyzer.merge_checkpoints, req)


@app.post("/sd/diarize", response_model=DiarizeResponse)
async def diarize(req: DiarizeRequest) -> DiarizeResponse:
    """Phase 2 placeholder — speaker diarization is not yet implemented.
    Returns 501 Not Implemented."""
    raise NotImplementedServiceError("/sd/diarize is reserved for Phase 2 diarization plugin")


@app.exception_handler(HTTPException)
async def handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=ErrorResponse(detail=str(exc.detail)).model_dump())


@app.exception_handler(Exception)
async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error")
    return JSONResponse(status_code=500, content=ErrorResponse(detail="internal server error").model_dump())
