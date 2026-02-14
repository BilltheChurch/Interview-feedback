# Inference API Contract（MVP-A / Phase 4+）

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

## 10. POST /analysis/events
- 输入：`session_id`、`transcript[]`、`memos[]`、`stats[]`、`locale`
- 输出：结构化 `events[]`，供 Worker 汇总到 `feedback-open` 与 `result_v2.trace`。

## 11. POST /analysis/report
- 输入：`session_id`、`transcript[]`、`memos[]`、`stats[]`、`evidence[]`、`events[]`、`locale`
- 输出：
  - `overall`
  - `per_person[]`
  - `quality`

`quality` 关键字段：
- `report_source: memo_first | llm_enhanced | llm_failed`
- `report_model: string | null`
- `report_degraded: boolean | null`
- `report_error: string | null`

约束：
- 每条 claim 必须包含 `evidence_refs`。
- 任一 claim 丢失证据时不得视为高质量报告。

## 12. POST /analysis/regenerate-claim
用于单条 claim 再生成（由 Worker `feedback-regenerate-claim` 调用）。

输入关键字段：
- `person_key`、`dimension`、`claim_type`
- `allowed_evidence_ids[]`（白名单）
- `evidence[]`（完整 evidence 集合）
- 可选 `claim_id`、`claim_text`、`text_hint`

输出：
- `claim`（含 `text` 与 `evidence_refs[]`）

强约束：
- 返回的 `evidence_refs` 必须是 `allowed_evidence_ids[]` 的非空子集。
- 空引用或非法引用应返回 `422`（上游不得静默修复）。

## 13. POST /analysis/synthesize

LLM-Core Synthesis 端点。Worker 准备完整的enriched数据（多证据、name bindings、stage metadata、context），发送到此端点，由 `ReportSynthesizer` 使用 DashScope LLM 生成全量报告（每条claim包含3-5条evidence citations）。

### 请求体 `SynthesizeReportRequest`

```json
{
  "session_id": "s-001",
  "transcript": [
    {
      "utterance_id": "u1",
      "stream_role": "students",
      "speaker_name": "Alice",
      "cluster_id": "c1",
      "decision": "auto",
      "text": "Let me explain the system architecture...",
      "start_ms": 0,
      "end_ms": 8000,
      "duration_ms": 8000
    }
  ],
  "memos": [
    {
      "memo_id": "m1",
      "created_at_ms": 4000,
      "author_role": "teacher",
      "type": "observation",
      "tags": ["structure"],
      "text": "Alice的架构阐述清晰",
      "stage": "Q1: System Design",
      "stage_index": 1
    }
  ],
  "free_form_notes": "候选人整体表现自信",
  "evidence": [
    {
      "evidence_id": "e_000001",
      "time_range_ms": [0, 8000],
      "utterance_ids": ["u1"],
      "speaker_key": "Alice",
      "quote": "Let me explain the system architecture...",
      "confidence": 0.85
    }
  ],
  "stats": [
    {
      "speaker_key": "Alice",
      "speaker_name": "Alice",
      "talk_time_ms": 8000,
      "turns": 1
    }
  ],
  "events": [],
  "rubric": {
    "template_name": "Technical Assessment",
    "dimensions": [
      { "name": "System Design", "description": "架构设计能力", "weight": 1.5 },
      { "name": "Communication", "weight": 1.0 }
    ]
  },
  "session_context": {
    "mode": "1v1",
    "interviewer_name": "Bob",
    "position_title": "Senior Engineer",
    "stage_descriptions": [
      { "stage_index": 0, "stage_name": "Intro" },
      { "stage_index": 1, "stage_name": "Q1: System Design" }
    ]
  },
  "memo_speaker_bindings": [
    {
      "memo_id": "m1",
      "extracted_names": ["Alice"],
      "matched_speaker_keys": ["Alice"],
      "confidence": 1.0
    }
  ],
  "historical": [
    {
      "session_id": "s-prev",
      "date": "2026-02-10",
      "summary": "前次面试表现扎实",
      "strengths": ["沟通清晰"],
      "risks": ["系统设计深度不足"]
    }
  ],
  "stages": ["Intro", "Q1: System Design", "Q2: Behavioral", "Wrap-up"],
  "locale": "zh-CN"
}
```

### 关键字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `session_id` | 是 | 会话ID，1-128字符 |
| `transcript` | 是 | 转写utterance数组 |
| `memos` | 否 | 面试官备忘录（支持 `stage`/`stage_index`） |
| `free_form_notes` | 否 | 自由文本备注 |
| `evidence` | 否 | 多证据条目（Worker `buildMultiEvidence` 输出） |
| `stats` | 否 | 发言人统计 |
| `events` | 否 | 分析事件 |
| `rubric` | 否 | 评分模板（含维度与权重） |
| `session_context` | 否 | 面试元信息（mode、interviewer、职位） |
| `memo_speaker_bindings` | 否 | Memo→Speaker名称绑定 |
| `historical` | 否 | 历史面试摘要 |
| `stages` | 否 | 面试阶段名称列表 |
| `locale` | 否 | 语言，默认 `zh-CN` |

### 响应 `AnalysisReportResponse`

```json
{
  "session_id": "s-001",
  "overall": {
    "summary_sections": [
      {
        "topic": "Interview Summary",
        "bullets": [
          "Alice demonstrated strong system design skills [e_000001]."
        ],
        "evidence_ids": ["e_000001"]
      }
    ],
    "team_dynamics": {
      "highlights": ["Strong leadership"],
      "risks": ["Limited depth in behavioral questions"]
    }
  },
  "per_person": [
    {
      "person_key": "Alice",
      "display_name": "Alice",
      "dimensions": [
        {
          "dimension": "leadership",
          "strengths": [
            {
              "claim_id": "c_Alice_leadership_01",
              "text": "Effectively led the system design discussion [e_000001].",
              "evidence_refs": ["e_000001"],
              "confidence": 0.88
            }
          ],
          "risks": [...],
          "actions": [...]
        }
      ],
      "summary": {
        "strengths": ["Strong system design"],
        "risks": ["Time management"],
        "actions": ["Practice structured responses"]
      }
    }
  ],
  "quality": {
    "generated_at": "2026-02-14T12:00:00Z",
    "build_ms": 3200,
    "claim_count": 15,
    "invalid_claim_count": 0,
    "needs_evidence_count": 0,
    "report_source": "llm_synthesized",
    "synthesis_context": {
      "rubric_used": true,
      "free_notes_used": true,
      "historical_sessions_count": 1,
      "name_bindings_count": 1,
      "stages_count": 4,
      "transcript_tokens_approx": 380,
      "transcript_truncated": false
    }
  }
}
```

### `quality.report_source` 值

| 值 | 说明 |
|----|------|
| `llm_synthesized` | LLM成功合成完整报告 |
| `llm_synthesized_truncated` | LLM成功但transcript被截断 |
| `memo_first_fallback` | LLM失败，回退到memo-first |

### `quality.synthesis_context` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `rubric_used` | bool | 是否使用了评分模板 |
| `free_notes_used` | bool | 是否使用了自由备注 |
| `historical_sessions_count` | int | 历史面试数量 |
| `name_bindings_count` | int | Memo→Speaker绑定数量 |
| `stages_count` | int | 面试阶段数量 |
| `transcript_tokens_approx` | int | 近似token数 |
| `transcript_truncated` | bool | transcript是否被截断 |

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 422 | 请求体校验失败（缺少`session_id`或`transcript`） |
| 500 | LLM调用失败且回退也失败 |

### 约束

- 每条 claim 的 `evidence_refs` 必须引用请求中 `evidence[]` 的 `evidence_id`。
- LLM 不可伪造 evidence_id，仅可使用 evidence_pack 中已有的ID。
- Transcript 超过 6000 tokens 时自动截断（保留首段与最近段）。
- 5个维度（leadership, collaboration, logic, structure, initiative）每人必须齐备。
- 维度缺失时自动填充 "Pending assessment" placeholder。
