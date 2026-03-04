"""Tests for OpenAILLMAdapter — interface compatibility + behaviour."""
from __future__ import annotations

import inspect
import json
from unittest.mock import MagicMock, patch

import pytest

from app.services.backends.llm_openai import OpenAILLMAdapter
from app.services.backends.llm_protocol import LLMConfig

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def config() -> LLMConfig:
    return LLMConfig(api_key="sk-test", model="gpt-4o-mini")


@pytest.fixture()
def adapter(config: LLMConfig) -> OpenAILLMAdapter:
    return OpenAILLMAdapter(config=config, redis_client=None)


# ---------------------------------------------------------------------------
# Interface compatibility with DashScopeLLMAdapter
# ---------------------------------------------------------------------------

def test_has_generate_json(adapter: OpenAILLMAdapter) -> None:
    assert hasattr(adapter, "generate_json")
    assert callable(adapter.generate_json)


def test_generate_json_signature(adapter: OpenAILLMAdapter) -> None:
    """Must accept the same keyword args as DashScopeLLMAdapter.generate_json."""
    sig = inspect.signature(adapter.generate_json)
    params = list(sig.parameters.keys())
    assert "system_prompt" in params
    assert "user_prompt" in params
    assert "json_schema" in params
    assert "timeout_ms" in params
    assert "idempotency_key" in params
    assert "pool" in params


def test_has_pool_semaphores(adapter: OpenAILLMAdapter) -> None:
    assert "checkpoint" in adapter._pools
    assert "finalize" in adapter._pools
    assert "default" in adapter._pools


def test_has_get_metrics(adapter: OpenAILLMAdapter) -> None:
    assert hasattr(adapter, "get_metrics")
    assert adapter.get_metrics() == []


# ---------------------------------------------------------------------------
# Redis idempotency (Constraint 4)
# ---------------------------------------------------------------------------

def test_redis_idempotency_cache_hit(config: LLMConfig) -> None:
    """When Redis has a cached result, _call_openai must NOT be called."""
    mock_redis = MagicMock()
    mock_redis.hget.return_value = json.dumps({"cached": True})

    adapter = OpenAILLMAdapter(config=config, redis_client=mock_redis)

    with patch.object(adapter, "_call_openai") as mock_call:
        result = adapter.generate_json(
            "sys", "user", idempotency_key="sess:chk1"
        )

    mock_call.assert_not_called()
    assert result == {"cached": True}


def test_redis_idempotency_cache_write(config: LLMConfig) -> None:
    """On successful call, result should be written to Redis idempotency hash."""
    mock_redis = MagicMock()
    mock_redis.hget.return_value = None  # cache miss

    adapter = OpenAILLMAdapter(config=config, redis_client=mock_redis)
    expected = {"answer": 42}

    with patch.object(adapter, "_call_openai", return_value=expected):
        result = adapter.generate_json(
            "sys", "user", idempotency_key="sess:chk2"
        )

    assert result == expected
    mock_redis.hset.assert_called_once_with(
        "llm:idem", "sess:chk2", json.dumps(expected)
    )
    mock_redis.expire.assert_called_once_with("llm:idem", 7200)


def test_no_redis_no_error(adapter: OpenAILLMAdapter) -> None:
    """With redis_client=None, idempotency is simply skipped — no AttributeError."""
    with patch.object(adapter, "_call_openai", return_value={"ok": True}):
        result = adapter.generate_json("sys", "user")
    assert result == {"ok": True}


# ---------------------------------------------------------------------------
# _call_openai HTTP layer
# ---------------------------------------------------------------------------

def _make_httpx_response(payload: dict, status: int = 200) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = status
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": json.dumps(payload)}}]
    }
    mock_resp.text = json.dumps(payload)
    return mock_resp


def test_call_openai_success(adapter: OpenAILLMAdapter) -> None:
    expected = {"score": 9}
    with patch("httpx.Client") as MockClient:
        mock_ctx = MockClient.return_value.__enter__.return_value
        mock_ctx.post.return_value = _make_httpx_response(expected)

        result = adapter._call_openai("sys", "user", 30000, None)

    assert result == expected


def test_call_openai_sends_json_mode_when_schema_given(adapter: OpenAILLMAdapter) -> None:
    schema = {"type": "object", "properties": {"score": {"type": "number"}}}
    with patch("httpx.Client") as MockClient:
        mock_ctx = MockClient.return_value.__enter__.return_value
        mock_ctx.post.return_value = _make_httpx_response({"score": 8})

        adapter._call_openai("sys", "user", 30000, schema)

    _, kwargs = mock_ctx.post.call_args
    assert kwargs["json"]["response_format"] == {"type": "json_object"}


def test_call_openai_no_json_mode_without_schema(adapter: OpenAILLMAdapter) -> None:
    with patch("httpx.Client") as MockClient:
        mock_ctx = MockClient.return_value.__enter__.return_value
        mock_ctx.post.return_value = _make_httpx_response({"result": "ok"})

        adapter._call_openai("sys", "user", 30000, None)

    _, kwargs = mock_ctx.post.call_args
    assert "response_format" not in kwargs["json"]


def test_call_openai_raises_on_http_error(adapter: OpenAILLMAdapter) -> None:
    with patch("httpx.Client") as MockClient:
        mock_ctx = MockClient.return_value.__enter__.return_value
        err_resp = MagicMock()
        err_resp.status_code = 401
        err_resp.text = "Unauthorized"
        mock_ctx.post.return_value = err_resp

        with pytest.raises(RuntimeError, match="401"):
            adapter._call_openai("sys", "user", 30000, None)


def test_call_openai_uses_base_url(config: LLMConfig) -> None:
    """Custom base_url must appear in the POST call path."""
    adapter = OpenAILLMAdapter(
        config=config,
        redis_client=None,
        base_url="https://my-azure.openai.azure.com/openai/deployments/gpt4",
    )
    with patch("httpx.Client") as MockClient:
        mock_ctx = MockClient.return_value.__enter__.return_value
        mock_ctx.post.return_value = _make_httpx_response({"ok": True})

        adapter._call_openai("sys", "user", 30000, None)

    url_called = mock_ctx.post.call_args[0][0]
    assert "my-azure.openai.azure.com" in url_called


# ---------------------------------------------------------------------------
# Config switching: dashscope vs openai
# ---------------------------------------------------------------------------

def test_config_provider_literal_accepts_openai() -> None:
    """Settings must accept 'openai' as REPORT_MODEL_PROVIDER."""
    from app.config import Settings

    s = Settings(
        REPORT_MODEL_PROVIDER="openai",
        OPENAI_API_KEY="sk-test",
        OPENAI_MODEL_NAME="gpt-4o-mini",
        OPENAI_BASE_URL="https://api.openai.com/v1",
    )
    assert s.report_model_provider == "openai"
    assert s.openai_model_name == "gpt-4o-mini"


def test_config_provider_literal_accepts_dashscope() -> None:
    from app.config import Settings

    s = Settings(REPORT_MODEL_PROVIDER="dashscope")
    assert s.report_model_provider == "dashscope"


def test_config_provider_rejects_unknown() -> None:
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(REPORT_MODEL_PROVIDER="anthropic")


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def test_metrics_recorded_after_successful_call(adapter: OpenAILLMAdapter) -> None:
    with patch.object(adapter, "_call_openai", return_value={"x": 1}):
        adapter.generate_json("sys", "user")

    metrics = adapter.get_metrics()
    assert len(metrics) == 1
    assert metrics[0].success is True
    assert metrics[0].model == "gpt-4o-mini"


def test_metrics_recorded_after_failed_call(adapter: OpenAILLMAdapter) -> None:
    with patch.object(adapter, "_call_openai", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            adapter.generate_json("sys", "user")

    metrics = adapter.get_metrics()
    assert len(metrics) == 1
    assert metrics[0].success is False
