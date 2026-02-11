# Inference API Contract（MVP-A）

## 1. GET /health
返回运行态元信息：

```json
{
  "status": "ok",
  "app_name": "interview-inference",
  "model_id": "iic/speech_campplus_sv_zh_en_16k-common_advanced",
  "model_revision": "v1.0.0",
  "embedding_dim": null,
  "sv_t_low": 0.45,
  "sv_t_high": 0.70,
  "max_request_body_bytes": 6291456,
  "rate_limit_enabled": true,
  "rate_limit_requests": 60,
  "rate_limit_window_seconds": 60,
  "segmenter_backend": "vad",
  "diarization_enabled": false
}
```

## 2. POST /sv/extract_embedding
请求：

```json
{
  "audio": {
    "content_b64": "<BASE64>",
    "format": "wav"
  }
}
```

响应：

```json
{
  "model_id": "iic/speech_campplus_sv_zh_en_16k-common_advanced",
  "model_revision": "v1.0.0",
  "embedding_dim": 192,
  "embedding": [0.12, -0.03]
}
```

## 3. POST /sv/score
请求：

```json
{
  "audio_a": {"content_b64": "<BASE64>", "format": "wav"},
  "audio_b": {"content_b64": "<BASE64>", "format": "wav"}
}
```

响应：

```json
{
  "model_id": "iic/speech_campplus_sv_zh_en_16k-common_advanced",
  "model_revision": "v1.0.0",
  "score": 0.78
}
```

## 4. POST /speaker/resolve
请求：

```json
{
  "session_id": "demo-session",
  "audio": {"content_b64": "<BASE64>", "format": "wav"},
  "asr_text": "Hi everyone, my name is Alice.",
  "state": {
    "clusters": [],
    "bindings": {},
    "roster": [{"name": "Alice", "email": "alice@x.com"}],
    "config": {}
  }
}
```

响应：

```json
{
  "session_id": "demo-session",
  "cluster_id": "c1",
  "speaker_name": "Alice",
  "decision": "auto",
  "evidence": {
    "sv_score": 0.82,
    "threshold_low": 0.45,
    "threshold_high": 0.70,
    "segment_count": 2,
    "name_hit": "Alice",
    "roster_hit": true
  },
  "updated_state": {
    "clusters": [
      {
        "cluster_id": "c1",
        "centroid": [0.12, -0.03],
        "sample_count": 2,
        "bound_name": "Alice"
      }
    ],
    "bindings": {"c1": "Alice"},
    "roster": [{"name": "Alice", "email": "alice@x.com"}],
    "config": {}
  }
}
```

## 5. POST /sd/diarize
- MVP-A 固定返回 `501 Not Implemented`。
- 保留请求结构以兼容 Phase 2 插件化接入。

## 6. 错误码
- 400：音频解码失败（非法 base64、ffmpeg 失败等）
- 413：请求体超过 `MAX_REQUEST_BODY_BYTES`
- 422：业务校验失败（无语音分段、时长超限等）
- 429：超过限流窗口（`RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS`）
- 500：SV 后端失败
- 501：Diarization 未启用/未实现

## 7. 鉴权（可选）
- 当环境变量 `INFERENCE_API_KEY` 非空时，所有请求必须带 `x-api-key` 请求头。
- 鉴权失败返回 `401`。
- 当开启限流时，响应头包含：
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`（Unix epoch 秒）
