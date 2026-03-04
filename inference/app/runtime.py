from __future__ import annotations

import logging
from dataclasses import dataclass

from app.config import Settings
from app.services.asr_router import LanguageAwareASRRouter
from app.services.backends.llm_dashscope import DashScopeLLMAdapter
from app.services.backends.llm_protocol import LLMConfig
from app.services.binder import BinderPolicy
from app.services.checkpoint_analyzer import CheckpointAnalyzer
from app.services.clustering import OnlineClusterer
from app.services.events_analyzer import EventsAnalyzer
from app.services.improvement_generator import ImprovementGenerator
from app.services.incremental_processor import IncrementalProcessor
from app.services.name_resolver import NameResolver
from app.services.orchestrator import InferenceOrchestrator
from app.services.redis_state import RedisSessionState
from app.services.report_generator import ReportGenerator
from app.services.report_synthesizer import ReportSynthesizer
from app.services.segmenters import DiarizationSegmenter, UnimplementedDiarizer, VADSegmenter
from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber
from app.services.sensevoice_transcriber import SenseVoiceTranscriber
from app.services.speaker_arbiter import SpeakerArbiter
from app.services.sv import ModelScopeSVBackend
from app.services.sv_onnx import OnnxSVBackend
from app.services.whisper_batch import WhisperBatchTranscriber

_logger = logging.getLogger(__name__)

# SV backend union type (duck typing — both have extract_embedding, score_embeddings, health, device)
SVBackend = ModelScopeSVBackend | OnnxSVBackend

# ASR backend union type (duck typing — all have transcribe, transcribe_pcm, device, backend, model_size)
ASRBackend = SenseVoiceTranscriber | SenseVoiceOnnxTranscriber | WhisperBatchTranscriber | LanguageAwareASRRouter


def build_asr_backend(settings: Settings) -> ASRBackend:
    """Factory: create ASR backend based on settings.asr_backend.

    When asr_backend is "sensevoice-onnx", automatically enables language-aware
    routing: English → Moonshine ONNX, other languages → SenseVoice ONNX.
    Falls back to SenseVoice-only if Moonshine model is not available.
    """
    if settings.asr_backend == "sensevoice":
        return SenseVoiceTranscriber(
            model_id=settings.sensevoice_model_id,
            device=settings.sensevoice_device,
            cache_dir=settings.modelscope_cache,
        )
    elif settings.asr_backend == "sensevoice-onnx":
        # Language-aware routing: SenseVoice (multilingual) + Moonshine (English)
        return LanguageAwareASRRouter(
            sensevoice_model_dir=settings.asr_onnx_model_path,
        )
    elif settings.asr_backend == "parakeet":
        try:
            from app.services.backends.asr_parakeet import ParakeetTDTTranscriber
            _logger.info("Loading Parakeet TDT ASR on %s", settings.parakeet_device)
            return ParakeetTDTTranscriber(
                model_name=settings.parakeet_model_name,
                device=settings.parakeet_device,
            )
        except Exception as exc:
            # Covers: ImportError (no nemo), RuntimeError (CUDA init fail),
            # OSError (missing shared lib), torch.cuda.CudaError, etc.
            _logger.warning(
                "Parakeet unavailable (%s: %s), falling back to sensevoice-onnx",
                type(exc).__name__, exc,
            )
            return LanguageAwareASRRouter(sensevoice_model_dir=settings.asr_onnx_model_path)
    else:
        return WhisperBatchTranscriber(
            model_size=settings.whisper_model_size,
            device=settings.whisper_device,
        )


@dataclass(slots=True)
class AppRuntime:
    settings: Settings
    orchestrator: InferenceOrchestrator
    sv_backend: SVBackend
    asr_backend: ASRBackend
    events_analyzer: EventsAnalyzer
    report_generator: ReportGenerator
    report_synthesizer: ReportSynthesizer
    improvement_generator: ImprovementGenerator
    checkpoint_analyzer: CheckpointAnalyzer
    incremental_processor: IncrementalProcessor
    redis_state: RedisSessionState | None
    recompute_asr: object | None  # SelectiveRecomputeASR | None (lazy import)


def build_runtime(settings: Settings) -> AppRuntime:
    if settings.segmenter_backend == "vad":
        segmenter = VADSegmenter(
            mode=settings.vad_mode,
            frame_ms=settings.vad_frame_ms,
            min_speech_ms=settings.vad_min_speech_ms,
            min_silence_ms=settings.vad_min_silence_ms,
        )
    else:
        segmenter = DiarizationSegmenter(diarizer=UnimplementedDiarizer())

    if settings.sv_backend == "onnx":
        sv_backend: SVBackend = OnnxSVBackend(
            model_path=settings.sv_onnx_model_path,
        )
    else:
        sv_backend = ModelScopeSVBackend(
            model_id=settings.sv_model_id,
            model_revision=settings.sv_model_revision,
            cache_dir=settings.modelscope_cache,
            device=settings.sv_device,
        )

    orchestrator = InferenceOrchestrator(
        settings=settings,
        segmenter=segmenter,
        sv_backend=sv_backend,
        clusterer=OnlineClusterer(match_threshold=settings.cluster_match_threshold),
        name_resolver=NameResolver(),
        binder=BinderPolicy(
            threshold_low=settings.sv_t_low,
            threshold_high=settings.sv_t_high,
            profile_auto_threshold=settings.profile_auto_threshold,
            profile_confirm_threshold=settings.profile_confirm_threshold,
            profile_margin_threshold=settings.profile_margin_threshold,
        ),
    )

    asr = build_asr_backend(settings)

    # Redis for V1 incremental state — initialize BEFORE LLM adapter so we can
    # pass redis_client at construction time (avoids private-attribute mutation).
    redis_state: RedisSessionState | None = None
    redis_client = None
    try:
        import redis
        rc = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        rc.ping()
        redis_state = RedisSessionState(rc, ttl_s=settings.redis_session_ttl_s)
        redis_client = rc
        _logger.info("Redis connected: %s", settings.redis_url)
    except Exception as exc:
        _logger.warning(
            "Redis unavailable (%s), V1 incremental endpoints will degrade: %s",
            settings.redis_url, exc,
        )

    # LLM backend factory — redis_client passed at construction (Constraint 4)
    if settings.report_model_provider == "openai":
        from app.services.backends.llm_openai import OpenAILLMAdapter
        llm_config = LLMConfig(
            api_key=settings.openai_api_key.get_secret_value(),
            model=settings.openai_model_name,
        )
        report_llm = OpenAILLMAdapter(
            config=llm_config,
            redis_client=redis_client,
            base_url=settings.openai_base_url,
        )
    else:
        llm_config = LLMConfig(
            api_key=settings.dashscope_api_key.get_secret_value(),
            model=settings.report_model_name,
        )
        report_llm = DashScopeLLMAdapter(config=llm_config, redis_client=redis_client)

    checkpoint_analyzer = CheckpointAnalyzer(llm=report_llm)

    # Diarizer for incremental processor (lazy-loaded, same as batch endpoint)
    if settings.diarization_backend == "nemo":
        from app.services.diarize_nemo import NemoMSDDDiarizer
        diarizer = NemoMSDDDiarizer(
            model_name=settings.nemo_model_name,
            device=settings.nemo_device,
        )
    else:
        from app.services.diarize_full import PyannoteFullDiarizer
        diarizer = PyannoteFullDiarizer(
            device=settings.pyannote_device,
            hf_token=settings.hf_token.get_secret_value(),
            model_id=settings.pyannote_model_id,
            embedding_model_id=settings.pyannote_embedding_model_id,
        )

    arbiter = SpeakerArbiter(sv_backend=sv_backend, confidence_threshold=0.50)

    incremental_processor = IncrementalProcessor(
        settings=settings,
        diarizer=diarizer,
        asr_backend=asr,
        checkpoint_analyzer=checkpoint_analyzer,
        arbiter=arbiter,
    )

    # Recompute ASR for finalize-time low-confidence correction (lazy-loaded)
    recompute_asr = None
    if settings.recompute_asr_enabled:
        try:
            from app.services.backends.asr_recompute import SelectiveRecomputeASR
            recompute_asr = SelectiveRecomputeASR(
                model_size=settings.recompute_asr_model_size,
                device=settings.recompute_asr_device,
            )
            _logger.info("Recompute ASR registered: %s on %s", settings.recompute_asr_model_size, settings.recompute_asr_device)
        except Exception as exc:
            _logger.warning("Recompute ASR unavailable (%s: %s)", type(exc).__name__, exc)

    return AppRuntime(
        settings=settings,
        orchestrator=orchestrator,
        sv_backend=sv_backend,
        asr_backend=asr,
        events_analyzer=EventsAnalyzer(),
        report_generator=ReportGenerator(llm=report_llm),
        report_synthesizer=ReportSynthesizer(llm=report_llm),
        improvement_generator=ImprovementGenerator(llm=report_llm),
        checkpoint_analyzer=checkpoint_analyzer,
        incremental_processor=incremental_processor,
        redis_state=redis_state,
        recompute_asr=recompute_asr,
    )
