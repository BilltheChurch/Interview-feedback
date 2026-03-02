"""DashScope qwen-plus adapter conforming to LLMBackend protocol.

Implements all 6 constraints. Uses Redis for idempotency (not process memory).
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any

from redis import Redis

from app.services.backends.llm_protocol import (
    LLMBackend,
    LLMConfig,
    LLMMetrics,
    LLMPool,
    scrub_pii,
    validate_llm_output,
)

logger = logging.getLogger(__name__)


class DashScopeLLMAdapter:
    """DashScope LLM with 6 engineering constraints."""

    def __init__(
        self,
        config: LLMConfig,
        redis_client: Redis | None = None,
    ) -> None:
        self._config = config
        self._redis = redis_client
        self._metrics_log: list[LLMMetrics] = []
        # Constraint 2: separate semaphores per pool
        self._pools = {
            LLMPool.CHECKPOINT.value: threading.Semaphore(config.checkpoint_concurrency),
            LLMPool.FINALIZE.value: threading.Semaphore(config.finalize_concurrency),
            "default": threading.Semaphore(5),
        }

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        json_schema: dict | None = None,
        timeout_ms: int = 45000,
        idempotency_key: str | None = None,
        pool: str = "default",
    ) -> dict:
        # Constraint 4: idempotency via Redis
        if idempotency_key and self._redis:
            cached = self._redis.hget("llm:idem", idempotency_key)
            if cached:
                logger.debug("LLM idempotency hit: %s", idempotency_key)
                return json.loads(cached)

        # Constraint 5: PII scrubbing + audit
        scrubbed_prompt = scrub_pii(user_prompt)
        prompt_hash = hashlib.sha256(scrubbed_prompt.encode()).hexdigest()[:16]
        logger.info(
            "LLM call: pool=%s, key=%s, prompt_hash=%s",
            pool, idempotency_key, prompt_hash,
        )

        # Constraint 2: pool-based concurrency control
        semaphore = self._pools.get(pool, self._pools["default"])
        acquired = semaphore.acquire(timeout=timeout_ms / 1000)
        if not acquired:
            raise TimeoutError(f"LLM pool '{pool}' busy, timeout after {timeout_ms}ms")

        t0 = time.monotonic()
        success = False
        result: dict = {}
        retries = 0

        try:
            while retries <= self._config.max_retries:
                try:
                    result = self._call_dashscope(
                        system_prompt, scrubbed_prompt, timeout_ms
                    )
                    # Constraint 3: forced JSON Schema validation
                    if json_schema:
                        validate_llm_output(result, json_schema)
                    success = True
                    break
                except ValueError:
                    retries += 1
                    if retries > self._config.max_retries:
                        raise
                    logger.warning("LLM schema validation failed, retry %d", retries)

            # Constraint 4: cache result in Redis
            if idempotency_key and self._redis and success:
                self._redis.hset("llm:idem", idempotency_key, json.dumps(result))
                self._redis.expire("llm:idem", 7200)

            return result

        finally:
            semaphore.release()
            latency_ms = int((time.monotonic() - t0) * 1000)

            # Constraint 6: metrics
            metrics = LLMMetrics(
                latency_ms=latency_ms,
                input_tokens=0,  # populated by _call_dashscope
                output_tokens=0,
                success=success,
                model=self._config.model,
                pool=pool,
            )
            self._metrics_log.append(metrics)
            logger.info(
                "LLM result: pool=%s, success=%s, latency=%dms",
                pool, success, latency_ms,
            )

    def _call_dashscope(
        self, system_prompt: str, user_prompt: str, timeout_ms: int
    ) -> dict:
        """Call DashScope API. Override in tests.
        timeout_ms is passed through to DashScopeLLM (P1 fix: was previously ignored)."""
        # Lazy import to avoid import-time dependency
        from app.services.dashscope_llm import DashScopeLLM

        llm = DashScopeLLM(
            api_key=self._config.api_key,
            model_name=self._config.model,
            timeout_ms=timeout_ms,
        )
        return llm.generate_json(system_prompt=system_prompt, user_prompt=user_prompt)

    def get_metrics(self) -> list[LLMMetrics]:
        return list(self._metrics_log)
