"""LLM Backend protocol with 6 engineering constraints.

Constraints:
1. Abstract LLMBackend — no direct DashScope SDK in business code
2. Separate pools: checkpoint (concurrency=3) vs finalize (concurrency=1)
3. Forced JSON Schema validation — fail → retry → raise, no silent degradation
4. Idempotency key (session_id:checkpoint_id) via Redis
5. PII scrubbing + audit log before outbound call
6. Metrics: latency, tokens, success, cost → stored for migration decisions
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

import jsonschema


class LLMPool(Enum):
    CHECKPOINT = "checkpoint"
    FINALIZE = "finalize"


@dataclass
class LLMConfig:
    api_key: str
    model: str
    checkpoint_concurrency: int = 3
    finalize_concurrency: int = 1
    checkpoint_timeout_ms: int = 30000
    finalize_timeout_ms: int = 60000
    max_retries: int = 1


@dataclass
class LLMMetrics:
    latency_ms: int
    input_tokens: int
    output_tokens: int
    success: bool
    model: str
    pool: str
    cost_estimate_cny: float = 0.0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@runtime_checkable
class LLMBackend(Protocol):
    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        json_schema: dict | None = None,
        timeout_ms: int = 45000,
        idempotency_key: str | None = None,
        pool: str = "default",
    ) -> dict: ...


def validate_llm_output(output: dict, schema: dict) -> None:
    """Constraint 3: forced JSON Schema validation."""
    try:
        jsonschema.validate(output, schema)
    except jsonschema.ValidationError as e:
        raise ValueError(f"LLM output failed schema validation: {e.message}") from e


# ── PII scrubbing (Constraint 5) ──────────────────────────────────

_PII_PATTERNS = [
    (re.compile(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b'), '[PHONE]'),          # US phone
    (re.compile(r'\b\d{11}\b'), '[PHONE]'),                               # CN phone
    (re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b'), '[EMAIL]'),            # email
    (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'), '[SSN]'),                    # SSN
    (re.compile(r'\b\d{17}[\dXx]\b'), '[ID_CARD]'),                      # CN ID
]


def scrub_pii(text: str) -> str:
    """Replace PII patterns with placeholders."""
    for pattern, replacement in _PII_PATTERNS:
        text = pattern.sub(replacement, text)
    return text
