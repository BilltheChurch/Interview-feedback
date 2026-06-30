# Setup Step 2 — Evaluation Rubric 合并 + 接通设计

> Status: Approved (brainstorm 2026-06-30)
> 动机: Session Setup Step 2 现有三个配置(Rubric Template / 面试类型 / Interview Flow)，其中前两个**既概念重叠又完全失效**（选了不影响报告），且「面试类型」全中文与表单不一致——上手成本高。

## 北极星

把 Step 2 的评分配置**合并成一个清晰、可编辑的「Evaluation Rubric」控件**，降低上手成本；并**真正接通**——面试官选/改的评分维度真的驱动报告对每位候选人的打分。Interview Flow（记笔记章节）正交且本就有用，保持独立不动。

## 现状（勘察 explore-setup-step2 + explore-worker-rubric，2026-06-30）

三处配置：
- **Rubric Template**（`SetupView.tsx` 内联 + `RubricTemplateModal.tsx`）：`BUILTIN_TEMPLATES`（general/technical/behavioral/panel，name+weight+description，**无 key**，英文）+ localStorage 自定义模板（key `ifb_rubric_templates`）。选中存 `templateId`，**从不进 worker**→失效。
- **面试类型**（`SetupView.tsx` 内联，全中文）：用 `lib/dimensionPresets.ts` 的 `DIMENSION_PRESETS`（academic/technical/behavioral/group，每类 5 维，有 `key`+`label_zh`+`label_en`+`description`+`weight`）。选中存 `interviewType`+`dimensionPresets`，**传进 startSession 后直接丢弃**→彻底失效。
- **Interview Flow**（`FlowEditor`）：`stages: string[]`，驱动记笔记章节+memo 打标+随 finalize 进 worker→**唯一真有用**。

worker 侧（关键）：**评分维度管线已全接通**。`/config` 已解析 `interview_type`+`dimension_presets` 存进 `state.config`（`index.ts:2046-2051`）；finalize orchestrator 已把它们拷进 `sessionContext`（`finalize-orchestrator.ts:417-422 / 1166-1171`）；synthesis **已参数化**——`getDimensionPresets(payload)` 读 `session_context.dimension_presets`→作 `evaluation_dimensions` 进 LLM prompt（`llm-synthesizer.ts:528/632`），output_contract 用 `dimension_presets[].key` 当维度键；没传才回退默认 5 维。`edge/worker/src/dimension-presets.ts` 与 desktop `lib/dimensionPresets.ts` **内容完全一致**（已同步，只是各存一份）。**唯一断点：desktop 从不把这两字段送出**（连 /config 都不调）。

## 已锁定的决策（brainstorm）

- **D1 · 预设 = System A 的 4 类**（academic/technical/behavioral/group，每类 5 维，用 `lib/dimensionPresets.ts`，有 key+双语+description）。**淘汰 `BUILTIN_TEMPLATES`（System B）**（无 key、不进 worker 的重复）。
- **D2 · 启用权重**：每维权重可调（如 1–5），且**权重真的影响报告打分/排序**——需改 worker synthesis 让 LLM 按权重加权（唯一非 trivial 的新 worker 逻辑）。
- **D3 · 完整编辑器**：选类型加载 5 维后，可改每维 name/description/weight、可加自定义维、可删（限 3–6 个）。**预设维改名保留原 key；新增维生成新 key**（slug/uuid）。
- **D4 · 保留可复用 custom 模板**：可把改好的 rubric 存成命名模板、下次直接选（localStorage，沿用/迁移 `ifb_rubric_templates`）。
- **D5 · Interview Flow 不动**（独立、正交、本就有用）。
- **D6 · 全英文 UI** + 顶部说明文字（点进去前就知道这套维度是「AI 据此给每位候选人打分」）。
- **D7 · 接通 channel = finalizeV2 metadata**（desktop 已发该 metadata，不新增 /config 调用、不与 hello 配置路径冲突）。

## 设计

### UI（SetupView Step 2，合并控件「Evaluation Rubric」）
- 删除现「Rubric Template」卡 + 「面试类型」卡 + `BUILTIN_TEMPLATES`；新增**一个** Evaluation Rubric 卡：
  1. **顶部说明**：一句「These dimensions are what the AI uses to score each candidate. Pick a type, then tweak.」
  2. **Interview Type 选择**：4 个 pill（Academic / Technical / Behavioral / Group），英文（用 `label_en` 思路给类型起英文名）。选中→把该类型的 5 维载入编辑器（默认权重 1）。
  3. **维度编辑器**（完整）：每行 = name(可编辑) + description(可编辑) + weight(可调，1–5) + 删除按钮（数量>3 才可删）；底部「+ Add dimension」（数量<6）新增空白自定义维。预设维保留原 `key`，自定义维生成新 `key`（slugify(name) + 短随机后缀，保证唯一/稳定）。
  4. **可复用模板**：「Save as template」存当前 rubric 为命名模板（localStorage）；已存模板在类型 pill 旁/下拉可选。沿用现有 `RubricTemplateModal` 的编辑/存取能力，迁移到新的统一数据形状。
- Interview Flow 卡保持原样。
- 全英文；遵循现有 liquid-glass 组件；不做 Phase X 级重设计。

### 数据模型
- 统一用 `DimensionPresetItem { key, label_en, label_zh?, description, weight }`（desktop `lib/dimensionPresets.ts` 已有；`label_zh` 对 UI 可选——UI 渲染 `label_en`）。
- 编辑器状态：`interviewType: string` + `dimensions: DimensionPresetItem[]`。
- **自定义维 key 生成（钉死，desktop 与未来 worker 校验须一致）**：`"custom_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) + "_" + <6位小写 base36 随机>`。若 name 为空/slug 为空，base 用 `"dim"`。预设维**改名不重算 key**（保留原 key）；仅新增的自定义维生成 key。
- 自定义模板（localStorage，沿用 key `ifb_rubric_templates`）：`{ id, name, interview_type, dimensions: DimensionPresetItem[] }`。**懒迁移**：载入时若某维无 `key`，即时按上面规则补生成（`if (!dim.key) dim.key = genKey(dim.name)`），不做启动期批量迁移、不丢弃旧模板。

### 接通（让评分真生效）
- **desktop**：在已有的 `finalizeV2` metadata（`useSessionFlow.ts`，现含 memos/stages/participants）里加 `interview_type` + `dimension_presets`（编辑器最终的维度数组，含 weight）。
- **worker**：在 finalize metadata 合并处（`finalize-orchestrator.ts` 的 metadata→state.config 合并，现仅并 memos/free_form_notes）加几行，把 `interview_type` + `dimension_presets` 并入 `state.config`。其余**已接通**（orchestrator→sessionContext→synthesis→evaluation_dimensions→per_person 按这些维度打分）。

### 权重生效（D2 — 唯一非 trivial 的新 worker 逻辑）
- **实锤现状**：`getDimensionPresets()`（`llm-synthesizer.ts:234-239`）在映射成 `evaluation_dimensions` 时**主动剥掉了 `weight`**（只留 key/label_zh/description），且 system prompt rule 4（`:421`）只说「每维 0-10 分」、**完全不提权重**。所以 weight 当前对报告**零影响**。
- **改法**：① `getDimensionPresets()` 映射时**保留 `weight`**，让 `evaluation_dimensions` 每项带上权重。② 改 system prompt rule 4：明确指示 LLM「按各维 `weight` 加权来形成 per-person 的 overall 评价与跨人排序——权重高的维度对总体结论影响更大；各维仍各自 0-10 打分，但 overall/排序按权重综合」。
- 可选增强（实现时定）：确定性地按 `weight` 计算 `per_person.overall_score`（加权平均维度分），减少对 LLM 自觉加权的依赖。spec 不强制，留实现判断；至少 prompt 要传达并要求加权。
- Tier2 跨人对比（若已上线）同理用加权——但 Tier2 是另一计划，本计划只保证 Tier1 synthesis 加权。

### 向后兼容 / 失败
- 不传 rubric（旧客户端/未选）→ worker 回退默认 5 维（现行为不变）。
- 自定义维 key 冲突/缺失 → 生成时保证唯一；载入旧模板补 key。
- 维度数量越界（<3 或 >6）→ UI 约束，送出前再夹一道。

## 复用 vs 新建

| 复用 | 新建/改 |
|---|---|
| `lib/dimensionPresets.ts`(4 类预设，已与 worker 同步)、`RubricTemplateModal` 的编辑/localStorage 能力、worker `/config`→sessionContext→synthesis 已接通的维度管线、`getDimensionPresets`/`evaluation_dimensions` | 合并 SetupView Step 2 两卡→一个 Evaluation Rubric 控件(英文+说明+完整编辑器+模板存取)；删 `BUILTIN_TEMPLATES`+面试类型卡；desktop finalizeV2 metadata 加 2 字段；worker finalize metadata 合并 2 字段进 config；**synthesis prompt 按 weight 加权**；自定义维 key 生成；旧 localStorage 模板迁移 |

## 不做（YAGNI）
- 不动 Interview Flow。
- 不做 Phase X 级 UI 重设计。
- 不强制确定性加权总分（prompt 加权为底线，确定性加权为可选增强）。
- 暂不把 rubric 经 hello/启动期 /config 送（finalize metadata 够用，避免与 hello 配置路径冲突）。

## 验证
- **单测**：自定义维 key 生成(唯一/稳定/预设改名保留 key)、维度数量夹取、finalizeV2 metadata 含 interview_type+dimension_presets、worker metadata 合并进 config、synthesis 在有 dimension_presets 时用其作维度(已有路径，补测加权指示)。
- **集成/live**：真实会话选 Technical → 报告 per_person 维度变成 coding/system_design 等(不是默认 leadership 那套)；调高某维 weight → 该维在 overall/排序里影响更大。
- desktop tsc + vitest 全绿；worker vitest + typecheck 全绿。

## 开放项
- 权重「确定性加权总分」是否要做（vs 仅 prompt 指示）——实现时按 LLM 加权可靠性定。
- 类型 pill 的英文命名：直接用 `Academic / Technical / Behavioral / Group`（`DimensionPresetTemplate` 无 `label_en`，pill 名按 `interview_type` 硬编码这四个英文即可）。
