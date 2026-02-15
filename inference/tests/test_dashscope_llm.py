"""Tests for DashScopeLLM — error handling, timeout, response parsing."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.exceptions import ValidationError
from app.services.dashscope_llm import DashScopeLLM, _get_shared_client, _shared_client


def _llm(api_key: str = "test-key", timeout_ms: int = 5000) -> DashScopeLLM:
    return DashScopeLLM(
        api_key=api_key,
        model_name="qwen-turbo",
        timeout_ms=timeout_ms,
    )


def _mock_response(
    status_code: int = 200,
    body: dict | str | None = None,
    *,
    is_json: bool = True,
) -> httpx.Response:
    """Build a mock httpx.Response."""
    if body is None:
        body = {
            "choices": [
                {"message": {"content": json.dumps({"result": "ok"})}}
            ]
        }
    if isinstance(body, dict):
        content = json.dumps(body).encode()
    else:
        content = body.encode()

    response = httpx.Response(
        status_code=status_code,
        content=content,
        request=httpx.Request("POST", "https://example.com"),
    )
    return response


# ── API key validation ──────────────────────────────────────────────────────


def test_empty_api_key_raises_validation_error() -> None:
    llm = _llm(api_key="   ")
    with pytest.raises(ValidationError, match="DASHSCOPE_API_KEY"):
        llm.generate_json(system_prompt="test", user_prompt="test")


# ── HTTP error responses ────────────────────────────────────────────────────


def test_4xx_response_raises_validation_error() -> None:
    llm = _llm()
    mock_response = _mock_response(status_code=400, body={"error": "bad request"})

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="status=400"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_500_response_raises_validation_error() -> None:
    llm = _llm()
    mock_response = _mock_response(status_code=500, body={"error": "server error"})

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="status=500"):
            llm.generate_json(system_prompt="test", user_prompt="test")


# ── Timeout handling ────────────────────────────────────────────────────────


def test_httpx_timeout_propagates() -> None:
    """httpx.TimeoutException should propagate (not silently swallowed)."""
    llm = _llm(timeout_ms=1000)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.side_effect = httpx.TimeoutException("connection timed out")
        mock_get_client.return_value = mock_client

        with pytest.raises(httpx.TimeoutException):
            llm.generate_json(system_prompt="test", user_prompt="test")


# ── Response parsing ────────────────────────────────────────────────────────


def test_valid_json_response_parsed() -> None:
    llm = _llm()
    expected = {"key": "value", "number": 42}
    body = {"choices": [{"message": {"content": json.dumps(expected)}}]}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        result = llm.generate_json(system_prompt="test", user_prompt="test")
        assert result == expected


def test_non_json_response_body_raises_validation_error() -> None:
    """If the HTTP response body is not JSON at all."""
    llm = _llm()

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        # Return a response whose .json() will raise
        response = httpx.Response(
            status_code=200,
            content=b"not json at all",
            request=httpx.Request("POST", "https://example.com"),
        )
        mock_client.post.return_value = response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="non-json"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_missing_choices_raises_validation_error() -> None:
    llm = _llm()
    body = {"data": "no choices key"}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="missing choices"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_empty_choices_raises_validation_error() -> None:
    llm = _llm()
    body = {"choices": []}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="missing choices"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_missing_message_content_raises_validation_error() -> None:
    llm = _llm()
    body = {"choices": [{"message": {"role": "assistant"}}]}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="missing message content"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_non_json_content_string_raises_validation_error() -> None:
    """Message content is a string but not valid JSON."""
    llm = _llm()
    body = {"choices": [{"message": {"content": "this is not json"}}]}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="not valid json"):
            llm.generate_json(system_prompt="test", user_prompt="test")


def test_whitespace_only_content_raises_validation_error() -> None:
    """Empty or whitespace-only content string."""
    llm = _llm()
    body = {"choices": [{"message": {"content": "   "}}]}
    mock_response = _mock_response(body=body)

    with patch("app.services.dashscope_llm._get_shared_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_get_client.return_value = mock_client

        with pytest.raises(ValidationError, match="missing message content"):
            llm.generate_json(system_prompt="test", user_prompt="test")


# ── Connection pooling ──────────────────────────────────────────────────────


def test_shared_client_is_reused() -> None:
    """_get_shared_client should return the same client on consecutive calls."""
    import app.services.dashscope_llm as mod

    # Reset module state
    mod._shared_client = None

    client1 = _get_shared_client(10.0)
    client2 = _get_shared_client(10.0)
    assert client1 is client2

    # Cleanup
    client1.close()
    mod._shared_client = None


def test_shared_client_recreated_when_closed() -> None:
    """If the shared client is closed, a new one should be created."""
    import app.services.dashscope_llm as mod

    mod._shared_client = None
    client1 = _get_shared_client(10.0)
    client1.close()

    client2 = _get_shared_client(10.0)
    assert client2 is not client1
    assert not client2.is_closed

    # Cleanup
    client2.close()
    mod._shared_client = None
