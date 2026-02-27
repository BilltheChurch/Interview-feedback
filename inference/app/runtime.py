from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings
from app.services.binder import BinderPolicy
from app.services.checkpoint_analyzer import CheckpointAnalyzer
from app.services.clustering import OnlineClusterer
from app.services.dashscope_llm import DashScopeLLM
from app.services.events_analyzer import EventsAnalyzer
from app.services.name_resolver import NameResolver
from app.services.orchestrator import InferenceOrchestrator
from app.services.report_generator import ReportGenerator
from app.services.improvement_generator import ImprovementGenerator
from app.services.report_synthesizer import ReportSynthesizer
from app.services.incremental_processor import IncrementalProcessor
from app.services.segmenters import DiarizationSegmenter, UnimplementedDiarizer, VADSegmenter
from app.services.asr_router import LanguageAwareASRRouter
from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber
from app.services.sensevoice_transcriber import SenseVoiceTranscriber
from app.services.sv import ModelScopeSVBackend
from app.services.sv_onnx import OnnxSVBackend
from app.services.whisper_batch import WhisperBatchTranscriber

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

    report_llm = DashScopeLLM(
        api_key=settings.dashscope_api_key.get_secret_value(),
        model_name=settings.report_model_name,
        timeout_ms=settings.report_timeout_ms,
    )

    checkpoint_analyzer = CheckpointAnalyzer(llm=report_llm)

    # Diarizer for incremental processor (lazy-loaded, same as batch endpoint)
    from app.services.diarize_full import PyannoteFullDiarizer
    diarizer = PyannoteFullDiarizer(
        device=settings.pyannote_device,
        hf_token=settings.hf_token.get_secret_value(),
        model_id=settings.pyannote_model_id,
        embedding_model_id=settings.pyannote_embedding_model_id,
    )

    incremental_processor = IncrementalProcessor(
        settings=settings,
        diarizer=diarizer,
        asr_backend=asr,
        checkpoint_analyzer=checkpoint_analyzer,
    )

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
    )
