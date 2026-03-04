"""Tests for Redis configuration settings."""
from app.config import Settings


def test_redis_url_default():
    """Redis URL has sensible default for local dev."""
    s = Settings(INFERENCE_API_KEY="test")
    assert s.redis_url == "redis://localhost:6379/0"


def test_redis_url_from_env(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://prod:6379/1")
    monkeypatch.setenv("INFERENCE_API_KEY", "test")
    s = Settings()
    assert s.redis_url == "redis://prod:6379/1"


def test_session_ttl_default():
    s = Settings(INFERENCE_API_KEY="test")
    assert s.redis_session_ttl_s == 7200


def test_ws_port_default():
    s = Settings(INFERENCE_API_KEY="test")
    assert s.ws_port == 8001
