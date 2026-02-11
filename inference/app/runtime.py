from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings
from app.services.binder import BinderPolicy
from app.services.clustering import OnlineClusterer
from app.services.name_resolver import NameResolver
from app.services.orchestrator import InferenceOrchestrator
from app.services.segmenters import DiarizationSegmenter, UnimplementedDiarizer, VADSegmenter
from app.services.sv import ModelScopeSVBackend


@dataclass(slots=True)
class AppRuntime:
    settings: Settings
    orchestrator: InferenceOrchestrator
    sv_backend: ModelScopeSVBackend


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

    sv_backend = ModelScopeSVBackend(
        model_id=settings.sv_model_id,
        model_revision=settings.sv_model_revision,
        cache_dir=settings.modelscope_cache,
    )

    orchestrator = InferenceOrchestrator(
        settings=settings,
        segmenter=segmenter,
        sv_backend=sv_backend,
        clusterer=OnlineClusterer(match_threshold=settings.cluster_match_threshold),
        name_resolver=NameResolver(),
        binder=BinderPolicy(threshold_low=settings.sv_t_low, threshold_high=settings.sv_t_high),
    )

    return AppRuntime(settings=settings, orchestrator=orchestrator, sv_backend=sv_backend)
