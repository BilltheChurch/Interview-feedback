from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from app.exceptions import ValidationError


@dataclass(slots=True)
class DashScopeLLM:
    api_key: str
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
        with httpx.Client(timeout=timeout_seconds) as client:
            response = client.post(self.base_url, headers=self._headers(), json=payload)

        if response.status_code >= 400:
            raise ValidationError(
                f"dashscope report request failed: status={response.status_code} body={response.text[:240]}"
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
