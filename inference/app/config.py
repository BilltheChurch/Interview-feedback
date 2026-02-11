from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(default="interview-inference", alias="APP_NAME")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8000, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    inference_api_key: str = Field(default="", alias="INFERENCE_API_KEY")

    sv_model_id: str = Field(
        default="iic/speech_campplus_sv_zh_en_16k-common_advanced",
        alias="SV_MODEL_ID",
    )
    sv_model_revision: str = Field(default="master", alias="SV_MODEL_REVISION")
    sv_t_low: float = Field(default=0.45, alias="SV_T_LOW")
    sv_t_high: float = Field(default=0.70, alias="SV_T_HIGH")
    cluster_match_threshold: float = Field(default=0.45, alias="CLUSTER_MATCH_THRESHOLD")

    audio_sr: int = Field(default=16000, alias="AUDIO_SR")
    max_audio_seconds: int = Field(default=30, alias="MAX_AUDIO_SECONDS")
    max_audio_bytes: int = Field(default=5 * 1024 * 1024, alias="MAX_AUDIO_BYTES")

    enable_diarization: bool = Field(default=False, alias="ENABLE_DIARIZATION")
    segmenter_backend: Literal["vad", "diarization"] = Field(default="vad", alias="SEGMENTER_BACKEND")
    modelscope_cache: str = Field(default="/modelscope-cache", alias="MODELSCOPE_CACHE")

    vad_mode: int = Field(default=2, alias="VAD_MODE")
    vad_frame_ms: int = Field(default=30, alias="VAD_FRAME_MS")
    vad_min_speech_ms: int = Field(default=300, alias="VAD_MIN_SPEECH_MS")
    vad_min_silence_ms: int = Field(default=250, alias="VAD_MIN_SILENCE_MS")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    if settings.sv_t_high <= settings.sv_t_low:
        raise ValueError("SV_T_HIGH must be greater than SV_T_LOW")
    if settings.vad_frame_ms not in {10, 20, 30}:
        raise ValueError("VAD_FRAME_MS must be one of: 10, 20, 30")
    return settings
