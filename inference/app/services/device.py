"""Shared GPU/compute device detection for all ML services."""

from __future__ import annotations

from typing import Literal

DeviceType = Literal["cuda", "rocm", "mps", "cpu"]


def detect_device() -> DeviceType:
    """Return the best available compute device (CUDA > ROCm > MPS > CPU)."""
    try:
        import torch

        if torch.cuda.is_available():
            if hasattr(torch.version, "hip") and torch.version.hip is not None:
                return "rocm"
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"
