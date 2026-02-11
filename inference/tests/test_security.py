from __future__ import annotations

from types import SimpleNamespace

from app.security import SlidingWindowRateLimiter, extract_client_ip, rate_limit_headers


class DummyRequest:
    def __init__(self, headers: dict[str, str], client_host: str | None = None) -> None:
        self.headers = headers
        self.client = SimpleNamespace(host=client_host) if client_host is not None else None


def test_rate_limiter_blocks_after_limit() -> None:
    limiter = SlidingWindowRateLimiter(requests_per_window=2, window_seconds=10)

    first = limiter.allow("client-a", now_seconds=100.0)
    second = limiter.allow("client-a", now_seconds=101.0)
    blocked = limiter.allow("client-a", now_seconds=102.0)

    assert first.allowed is True
    assert second.allowed is True
    assert blocked.allowed is False
    assert blocked.remaining == 0
    assert blocked.limit == 2


def test_rate_limiter_recovers_after_window() -> None:
    limiter = SlidingWindowRateLimiter(requests_per_window=2, window_seconds=10)

    limiter.allow("client-a", now_seconds=100.0)
    limiter.allow("client-a", now_seconds=101.0)
    blocked = limiter.allow("client-a", now_seconds=102.0)
    allowed_again = limiter.allow("client-a", now_seconds=111.1)

    assert blocked.allowed is False
    assert allowed_again.allowed is True


def test_extract_client_ip_prefers_x_forwarded_for() -> None:
    request = DummyRequest(
        headers={"x-forwarded-for": "203.0.113.10, 198.51.100.5", "cf-connecting-ip": "198.51.100.9"},
        client_host="127.0.0.1",
    )

    ip = extract_client_ip(request=request, trust_proxy_headers=True)
    assert ip == "203.0.113.10"


def test_extract_client_ip_falls_back_to_client_host() -> None:
    request = DummyRequest(headers={}, client_host="127.0.0.1")
    ip = extract_client_ip(request=request, trust_proxy_headers=False)
    assert ip == "127.0.0.1"


def test_rate_limit_headers_format() -> None:
    limiter = SlidingWindowRateLimiter(requests_per_window=3, window_seconds=10)
    decision = limiter.allow("client-a", now_seconds=200.0)

    headers = rate_limit_headers(decision)
    assert headers["X-RateLimit-Limit"] == "3"
    assert headers["X-RateLimit-Remaining"] == "2"
    assert headers["X-RateLimit-Reset"].isdigit()
