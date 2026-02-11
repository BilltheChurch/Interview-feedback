from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from threading import Lock
import time

from fastapi import Request


@dataclass(slots=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    reset_epoch_seconds: int


class SlidingWindowRateLimiter:
    """In-memory per-client sliding-window limiter.

    This limiter is process-local. For multi-instance deployments,
    place rate limiting at an upstream gateway (e.g., Cloudflare Worker).
    """

    def __init__(self, requests_per_window: int, window_seconds: int, max_clients: int = 10000) -> None:
        if requests_per_window <= 0:
            raise ValueError("requests_per_window must be > 0")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be > 0")
        if max_clients <= 0:
            raise ValueError("max_clients must be > 0")

        self._requests_per_window = requests_per_window
        self._window_seconds = window_seconds
        self._max_clients = max_clients
        self._lock = Lock()
        self._events: dict[str, deque[float]] = {}

    def allow(self, client_key: str, now_seconds: float | None = None) -> RateLimitDecision:
        now = now_seconds if now_seconds is not None else time.time()

        with self._lock:
            bucket = self._events.setdefault(client_key, deque())
            cutoff = now - self._window_seconds

            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= self._requests_per_window:
                reset_at = int(bucket[0] + self._window_seconds) if bucket else int(now + self._window_seconds)
                return RateLimitDecision(
                    allowed=False,
                    limit=self._requests_per_window,
                    remaining=0,
                    reset_epoch_seconds=reset_at,
                )

            bucket.append(now)
            reset_at = int(bucket[0] + self._window_seconds)
            remaining = self._requests_per_window - len(bucket)

            self._evict_stale_keys(now=now)

            return RateLimitDecision(
                allowed=True,
                limit=self._requests_per_window,
                remaining=remaining,
                reset_epoch_seconds=reset_at,
            )

    def _evict_stale_keys(self, now: float) -> None:
        if len(self._events) <= self._max_clients:
            return

        cutoff = now - self._window_seconds
        stale_keys: list[str] = []
        for key, bucket in self._events.items():
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if not bucket:
                stale_keys.append(key)

        for key in stale_keys:
            self._events.pop(key, None)


def extract_client_ip(request: Request, trust_proxy_headers: bool) -> str:
    if trust_proxy_headers:
        x_forwarded_for = request.headers.get("x-forwarded-for", "")
        if x_forwarded_for:
            for part in x_forwarded_for.split(","):
                candidate = part.strip()
                if candidate:
                    return candidate[:128]

        cf_connecting_ip = request.headers.get("cf-connecting-ip", "").strip()
        if cf_connecting_ip:
            return cf_connecting_ip[:128]

    if request.client and request.client.host:
        return request.client.host[:128]

    return "unknown"


def rate_limit_headers(decision: RateLimitDecision) -> dict[str, str]:
    return {
        "X-RateLimit-Limit": str(decision.limit),
        "X-RateLimit-Remaining": str(max(decision.remaining, 0)),
        "X-RateLimit-Reset": str(decision.reset_epoch_seconds),
    }
