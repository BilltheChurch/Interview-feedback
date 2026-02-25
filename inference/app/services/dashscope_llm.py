from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field

import httpx

from app.exceptions import ValidationError

logger = logging.getLogger(__name__)

# Module-level shared client for connection pooling across requests.
# This avoids creating a new TCP connection + TLS handshake per LLM call.
_shared_client: httpx.Client | None = None
_shared_client_lock = threading.Lock()


def _get_shared_client(timeout: float) -> httpx.Client:
    global _shared_client
    if _shared_client is not None and not _shared_client.is_closed:
        return _shared_client
    with _shared_client_lock:
        if _shared_client is None or _shared_client.is_closed:
            _shared_client = httpx.Client(timeout=timeout)
    return _shared_client


@dataclass(slots=True)
class DashScopeLLM:
    api_key: str = field(repr=False)
    model_name: str
    timeout_ms: int
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

    def _headers(self) -> dict[str, str]:
        if not self.api_key.strip():
            raise ValidationError("DASHSCOPE_API_KEY is required for report generation")
        return {
            "Authorization": f"Bearer {self.api_key.strip()}",
            "Content-Type": "application/json",
        }

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        payload = {
            "model": self.model_name,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }

        timeout_seconds = max(self.timeout_ms, 1000) / 1000
        client = _get_shared_client(timeout_seconds)

        retryable_codes = {429, 502, 503}
        max_retries = 2
        last_status = 0
        last_body = ""

        for attempt in range(max_retries + 1):
            try:
                response = client.post(self.base_url, headers=self._headers(), json=payload)
            except httpx.TimeoutException:
                if attempt < max_retries:
                    time.sleep(min(2 ** attempt * 0.5, 5.0))
                    continue
                raise ValidationError("Report generation service timed out after retries")

            last_status = response.status_code
            last_body = response.text[:500]

            if response.status_code < 400:
                break

            if response.status_code in retryable_codes and attempt < max_retries:
                logger.warning(
                    "dashscope %s retryable error: status=%s attempt=%d/%d",
                    self.model_name, response.status_code, attempt + 1, max_retries + 1
                )
                time.sleep(min(2 ** attempt * 0.5, 5.0))
                continue

            # Non-retryable error or exhausted retries
            logger.error(
                "dashscope %s failed: status=%s body=%s prompt_len=sys:%d+user:%d",
                self.model_name, response.status_code, response.text[:500],
                len(system_prompt), len(user_prompt)
            )
            raise ValidationError(
                f"Report generation service temporarily unavailable (status={response.status_code})"
            )

        try:
            parsed = response.json()
        except ValueError as exc:
            raise ValidationError("dashscope returned non-json response") from exc

        choices = parsed.get("choices")
        if not isinstance(choices, list) or len(choices) == 0:
            raise ValidationError("dashscope response missing choices")

        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise ValidationError("dashscope response missing message content")

        try:
            return json.loads(content)
        except ValueError as exc:
            raise ValidationError("dashscope response content is not valid json") from exc
