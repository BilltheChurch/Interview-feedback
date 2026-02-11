# Inference API Contract（MVP-A / Phase 2.3.1）

## 1. GET /health
返回运行态元信息（模型、阈值、限流、分段后端）。

## 2. POST /sv/extract_embedding
输入一段音频，返回固定维度 embedding。

## 3. POST /sv/score
输入两段音频，返回相似度分数。

## 4. POST /speaker/enroll
用于开场 Enrollment 采样，把 participant 声纹样本累积到 `state.participant_profiles`。

请求：

```json
{
  "session_id": "teams-test3",
  "participant_name": "Alice",
  "audio": {"content_b64": "<BASE64>", "format": "wav"},
  "state": {
    "clusters": [],
    "bindings": {},
    "roster": [{"name": "Alice", "email": "alice@x.com"}],
    "config": {},
    "participant_profiles": [],
    "cluster_binding_meta": {}
  }
}
```

响应：

```json
{
  "session_id": "teams-test3",
  "participant_name": "Alice",
  "embedding_dim": 192,
  "sample_seconds": 12.4,
  "profile_updated": true,
  "updated_state": {
    "participant_profiles": [
      {
        "name": "Alice",
        "email": "alice@x.com",
        "centroid": [0.01, -0.04],
        "sample_count": 3,
        "sample_seconds": 12.4,
        "status": "ready"
      }
    ]
  }
}
```

## 5. POST /speaker/resolve
主识别接口（students 流调用）。

决策顺序：
- locked manual binding
- existing binding
- enrollment profile match
- name extract（roster 内）
- unknown

语义约束：
- 不允许 `decision=confirm` 且 `speaker_name=null`
- 无法命名时必须返回 `decision=unknown`

`ResolveEvidence` 扩展字段：
- `profile_top_name`
- `profile_top_score`
- `profile_margin`
- `binding_source`
- `reason`

## 6. SessionState 扩展

`SessionState` 在原有字段上新增：
- `participant_profiles: ParticipantProfile[]`
- `cluster_binding_meta: Record<string, BindingMeta>`

`BindingMeta`:
- `participant_name`
- `source: enrollment_match | name_extract | manual_map`
- `confidence`
- `locked`
- `updated_at`

## 7. POST /sd/diarize
- MVP-A 固定返回 `501 Not Implemented`。
- 仅保留接口与 schema，为后续可插拔 diarization 预留。

## 8. 错误码
- 400：音频解码失败
- 413：请求体超过限制
- 422：业务校验失败（无有效语音片段、时长超限等）
- 429：限流
- 500：SV/推理后端错误
- 501：Diarization 未启用

## 9. 鉴权
- 配置 `INFERENCE_API_KEY` 后，所有请求必须携带 `x-api-key`。
