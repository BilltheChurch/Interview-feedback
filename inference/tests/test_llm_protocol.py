"""Tests for LLM backend protocol and DashScope adapter with 6 constraints."""
import json

import pytest

try:
    import fakeredis
    HAS_FAKEREDIS = True
except ImportError:
    HAS_FAKEREDIS = False

from app.services.backends.llm_protocol import (
    LLMBackend,
    LLMConfig,
    LLMMetrics,
    LLMPool,
)


def test_llm_config_defaults():
    config = LLMConfig(api_key="test-key", model="qwen-plus")
    assert config.checkpoint_concurrency == 3
    assert config.finalize_concurrency == 1
    assert config.checkpoint_timeout_ms == 30000
    assert config.finalize_timeout_ms == 60000


def test_llm_pool_enum():
    assert LLMPool.CHECKPOINT.value == "checkpoint"
    assert LLMPool.FINALIZE.value == "finalize"


def test_llm_metrics_dataclass():
    m = LLMMetrics(
        latency_ms=1500,
        input_tokens=200,
        output_tokens=500,
        success=True,
        model="qwen-plus",
        pool="checkpoint",
    )
    assert m.total_tokens == 700


def test_llm_protocol_check():
    class FakeLLM:
        def generate_json(self, system_prompt, user_prompt, **kwargs):
            return {"test": True}

    assert isinstance(FakeLLM(), LLMBackend)


@pytest.mark.skipif(not HAS_FAKEREDIS, reason="fakeredis not installed")
def test_idempotency_via_redis():
    """Constraint 4: idempotency uses Redis, not process memory."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter

    r = fakeredis.FakeRedis(decode_responses=True)
    adapter = DashScopeLLMAdapter(
        config=LLMConfig(api_key="test", model="qwen-plus"),
        redis_client=r,
    )
    # Simulate a cached result
    r.hset("llm:idem", "sess-1:checkpoint:0", json.dumps({"cached": True}))
    result = adapter.generate_json(
        "system", "user",
        idempotency_key="sess-1:checkpoint:0",
    )
    assert result == {"cached": True}


def test_json_schema_validation_fails():
    """Constraint 3: JSON Schema validation rejects bad output."""
    from app.services.backends.llm_protocol import validate_llm_output

    schema = {
        "type": "object",
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    # Valid
    validate_llm_output({"summary": "test"}, schema)
    # Invalid — should raise
    with pytest.raises(ValueError, match="schema"):
        validate_llm_output({"wrong_key": 123}, schema)
