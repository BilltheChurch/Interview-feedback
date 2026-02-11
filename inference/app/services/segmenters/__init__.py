from app.services.segmenters.base import Segment, Segmenter
from app.services.segmenters.diarization import DiarizationSegmenter, Diarizer, SpeakerTrack, UnimplementedDiarizer

try:
    from app.services.segmenters.vad import VADSegmenter
except ModuleNotFoundError as exc:
    _vad_import_error = exc

    class VADSegmenter:  # type: ignore[override]
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003, D401
            raise ModuleNotFoundError(
                "VADSegmenter requires the 'webrtcvad' dependency. Install inference requirements."
            ) from _vad_import_error

__all__ = [
    "DiarizationSegmenter",
    "Diarizer",
    "Segment",
    "Segmenter",
    "SpeakerTrack",
    "UnimplementedDiarizer",
    "VADSegmenter",
]
