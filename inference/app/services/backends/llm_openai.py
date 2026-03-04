"""OpenAI-compatible LLM adapter.

Supports OpenAI GPT-4o-mini and compatible APIs (Azure OpenAI, local models).
Uses the same LLMProtocol interface as DashScopeLLMAdapter.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any

import httpx
from redis import Redis

from app.services.backends.llm_protocol import (
    LLMConfig,
    LLMMetrics,
    LLMPool,
    scrub_pii,
    validate_llm_output,
)

logger = logging.getLogger(__name__)


class OpenAILLMAdapter:
    """OpenAI-compatible LLM adapter with the same 6 engineering constraints as DashScopeLLMAdapter."""

    def __init__(
        self,
        config: LLMConfig,
        redis_client: Redis | None = None,
        base_url: str = "https://api.openai.com/v1",
    ) -> None:
        self._config = config
        self._redis = redis_client
        self._base_url = base_url.rstrip("/")
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
                    result = self._call_openai(
                        system_prompt, scrubbed_prompt, timeout_ms, json_schema
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
                input_tokens=0,
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

    def _call_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        timeout_ms: int,
        json_schema: dict | None,
    ) -> dict:
        """Call OpenAI-compatible chat completions endpoint via httpx."""
        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }

        # Request JSON mode when a schema is provided
        if json_schema is not None:
            payload["response_format"] = {"type": "json_object"}

        timeout_s = timeout_ms / 1000
        with httpx.Client(timeout=timeout_s) as client:
            resp = client.post(
                f"{self._base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._config.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        if resp.status_code != 200:
            raise RuntimeError(
                f"OpenAI API error {resp.status_code}: {resp.text[:200]}"
            )

        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)

    def get_metrics(self) -> list[LLMMetrics]:
        return list(self._metrics_log)
