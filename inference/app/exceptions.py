class InferenceError(RuntimeError):
    """Base exception for business-level inference errors."""


class UnauthorizedError(InferenceError):
    """Raised when request authentication fails."""


class AudioDecodeError(InferenceError):
    """Raised when input audio cannot be decoded or normalized."""


class ValidationError(InferenceError):
    """Raised when request payload violates service constraints."""


class PayloadTooLargeError(ValidationError):
    """Raised when input payload exceeds max allowed size."""


class SVBackendError(InferenceError):
    """Raised when speaker verification backend fails."""


class NotImplementedServiceError(InferenceError):
    """Raised when requested feature exists but is not enabled/implemented."""
