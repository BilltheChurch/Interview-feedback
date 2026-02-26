from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(default="interview-inference", alias="APP_NAME")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8000, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    inference_api_key: SecretStr = Field(default="", alias="INFERENCE_API_KEY")
    trust_proxy_headers: bool = Field(default=True, alias="TRUST_PROXY_HEADERS")

    sv_model_id: str = Field(
        default="iic/speech_campplus_sv_zh_en_16k-common_advanced",
        alias="SV_MODEL_ID",
    )
    sv_model_revision: str = Field(default="master", alias="SV_MODEL_REVISION")
    sv_t_low: float = Field(default=0.60, alias="SV_T_LOW")
    sv_t_high: float = Field(default=0.70, alias="SV_T_HIGH")
    cluster_match_threshold: float = Field(default=0.60, alias="CLUSTER_MATCH_THRESHOLD")
    profile_auto_threshold: float = Field(default=0.72, alias="PROFILE_AUTO_THRESHOLD")
    profile_confirm_threshold: float = Field(default=0.60, alias="PROFILE_CONFIRM_THRESHOLD")
    profile_margin_threshold: float = Field(default=0.08, alias="PROFILE_MARGIN_THRESHOLD")
    enrollment_ready_seconds: float = Field(default=12.0, alias="ENROLLMENT_READY_SECONDS")
    enrollment_ready_samples: int = Field(default=3, alias="ENROLLMENT_READY_SAMPLES")
    report_model_provider: Literal["dashscope"] = Field(default="dashscope", alias="REPORT_MODEL_PROVIDER")
    report_model_name: str = Field(default="qwen-plus", alias="REPORT_MODEL_NAME")
    dashscope_api_key: SecretStr = Field(default="", alias="DASHSCOPE_API_KEY")
    report_timeout_ms: int = Field(default=45000, alias="REPORT_TIMEOUT_MS")

    audio_sr: int = Field(default=16000, alias="AUDIO_SR")
    max_audio_seconds: int = Field(default=30, alias="MAX_AUDIO_SECONDS")
    max_audio_bytes: int = Field(default=5 * 1024 * 1024, alias="MAX_AUDIO_BYTES")
    max_request_body_bytes: int = Field(default=6 * 1024 * 1024, alias="MAX_REQUEST_BODY_BYTES")

    rate_limit_enabled: bool = Field(default=True, alias="RATE_LIMIT_ENABLED")
    rate_limit_requests: int = Field(default=60, alias="RATE_LIMIT_REQUESTS")
    rate_limit_window_seconds: int = Field(default=60, alias="RATE_LIMIT_WINDOW_SECONDS")

    enable_diarization: bool = Field(default=False, alias="ENABLE_DIARIZATION")
    segmenter_backend: Literal["vad", "diarization"] = Field(default="vad", alias="SEGMENTER_BACKEND")
    modelscope_cache: str = Field(default="~/.cache/modelscope", alias="MODELSCOPE_CACHE")
    sv_device: str = Field(default="auto", alias="SV_DEVICE")

    vad_mode: int = Field(default=2, alias="VAD_MODE")
    vad_frame_ms: int = Field(default=30, alias="VAD_FRAME_MS")
    vad_min_speech_ms: int = Field(default=300, alias="VAD_MIN_SPEECH_MS")
    vad_min_silence_ms: int = Field(default=250, alias="VAD_MIN_SILENCE_MS")

    # ASR backend selection
    asr_backend: Literal["sensevoice", "whisper", "whisper-cpp"] = Field(
        default="sensevoice", alias="ASR_BACKEND"
    )
    sensevoice_model_id: str = Field(
        default="iic/SenseVoiceSmall", alias="SENSEVOICE_MODEL_ID"
    )
    sensevoice_device: str = Field(default="auto", alias="SENSEVOICE_DEVICE")

    # Tier 2 batch processing
    whisper_model_size: str = Field(default="large-v3", alias="WHISPER_MODEL_SIZE")
    whisper_device: str = Field(default="auto", alias="WHISPER_DEVICE")
    pyannote_model_id: str = Field(
        default="pyannote/speaker-diarization-3.1", alias="PYANNOTE_MODEL_ID"
    )
    pyannote_embedding_model_id: str = Field(
        default="pyannote/wespeaker-voxceleb-resnet34-LM", alias="PYANNOTE_EMBEDDING_MODEL_ID"
    )
    pyannote_device: str = Field(default="auto", alias="PYANNOTE_DEVICE")
    hf_token: SecretStr = Field(default="", alias="HF_TOKEN")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    if settings.sv_t_high <= settings.sv_t_low:
        raise ValueError("SV_T_HIGH must be greater than SV_T_LOW")
    if settings.profile_auto_threshold < settings.profile_confirm_threshold:
        raise ValueError("PROFILE_AUTO_THRESHOLD must be >= PROFILE_CONFIRM_THRESHOLD")
    if settings.enrollment_ready_seconds <= 0:
        raise ValueError("ENROLLMENT_READY_SECONDS must be greater than 0")
    if settings.enrollment_ready_samples <= 0:
        raise ValueError("ENROLLMENT_READY_SAMPLES must be greater than 0")
    if settings.vad_frame_ms not in {10, 20, 30}:
        raise ValueError("VAD_FRAME_MS must be one of: 10, 20, 30")
    if settings.report_timeout_ms <= 0:
        raise ValueError("REPORT_TIMEOUT_MS must be greater than 0")
    if settings.max_request_body_bytes <= 0:
        raise ValueError("MAX_REQUEST_BODY_BYTES must be greater than 0")
    if settings.rate_limit_enabled and settings.rate_limit_requests <= 0:
        raise ValueError("RATE_LIMIT_REQUESTS must be greater than 0 when RATE_LIMIT_ENABLED=true")
    if settings.rate_limit_enabled and settings.rate_limit_window_seconds <= 0:
        raise ValueError("RATE_LIMIT_WINDOW_SECONDS must be greater than 0 when RATE_LIMIT_ENABLED=true")
    return settings
