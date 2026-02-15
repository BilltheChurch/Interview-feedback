from __future__ import annotations

import hmac
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
    RegenerateClaimRequest,
    RegenerateClaimResponse,
    HealthResponse,
    ResolveRequest,
    ResolveResponse,
    ScoreRequest,
    ScoreResponse,
    SynthesizeReportRequest,
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


@app.middleware("http")
async def request_guard(request: Request, call_next):
    if settings.inference_api_key:
        incoming_key = request.headers.get("x-api-key", "")
        if not hmac.compare_digest(incoming_key.encode(), settings.inference_api_key.encode()):
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
        max_request_body_bytes=settings.max_request_body_bytes,
        rate_limit_enabled=settings.rate_limit_enabled,
        rate_limit_requests=settings.rate_limit_requests,
        rate_limit_window_seconds=settings.rate_limit_window_seconds,
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


@app.post("/speaker/enroll", response_model=EnrollResponse)
async def enroll_speaker(req: EnrollRequest) -> EnrollResponse:
    return runtime.orchestrator.enroll(
        session_id=req.session_id,
        participant_name=req.participant_name,
        audio_payload=req.audio,
        state=req.state,
    )


@app.post("/analysis/events", response_model=AnalysisEventsResponse)
async def analyze_events(req: AnalysisEventsRequest) -> AnalysisEventsResponse:
    events = runtime.events_analyzer.analyze(
        session_id=req.session_id,
        transcript=req.transcript,
        memos=req.memos,
        stats=req.stats,
    )
    return AnalysisEventsResponse(session_id=req.session_id, events=events)


@app.post("/analysis/report", response_model=AnalysisReportResponse)
async def analyze_report(req: AnalysisReportRequest) -> AnalysisReportResponse:
    return runtime.report_generator.generate(req)


@app.post("/analysis/regenerate-claim", response_model=RegenerateClaimResponse)
async def regenerate_claim(req: RegenerateClaimRequest) -> RegenerateClaimResponse:
    return runtime.report_generator.regenerate_claim(req)


@app.post("/analysis/synthesize", response_model=AnalysisReportResponse)
async def synthesize_report(req: SynthesizeReportRequest) -> AnalysisReportResponse:
    return runtime.report_synthesizer.synthesize(req)


@app.post("/sd/diarize", response_model=DiarizeResponse)
async def diarize(req: DiarizeRequest) -> DiarizeResponse:
    raise NotImplementedServiceError("/sd/diarize is reserved for Phase 2 diarization plugin")


@app.exception_handler(HTTPException)
async def handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=ErrorResponse(detail=str(exc.detail)).model_dump())


@app.exception_handler(Exception)
async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error")
    return JSONResponse(status_code=500, content=ErrorResponse(detail="internal server error").model_dump())
