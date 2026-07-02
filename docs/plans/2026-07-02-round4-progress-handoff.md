# Round-4 真人测试修复 — 进展交接文档

> **✅ 已完成 (2026-07-02 后续会话)**：③ 打字机改动 2 按本文档规格重做（上会话未提交改动确认丢失）并提交 `0f066df`；对抗式复审确认 3 真问题并补修（desktop render 期 clamp + hook 测试 `cfca81a`；worker partial 拼接缓冲前缀 `834d163`）。worker 764 / desktop 385 全绿；已部署 Worker Version `4ac750c1` + 重建 dist；Task.md 条目⑪已记录。本文档仅作历史参考。

> **日期**: 2026-07-02
> **分支**: `claude/ecstatic-chaum-51c7eb`（worktree）
> **交接原因**: 会话即将退出，记录当前真实进展，方便下次无缝继续。
> **⚠️ 重要**: 本会话中途因用户手动中断任务，产生过大量"乱码/幻觉"工具输出（伪造的 SHA、伪造的完成通知）。**下次继续时，务必只信任 `git` 命令的真实输出来判断状态，不要相信本文档以外的任何"记忆"。** 所有下述 SHA 均已用 `git cat-file -e` 验证真实存在。

---

## 一、Round-4 用户反馈的 6 类问题

真人测试（英文 session，speaker "Tim"，1v1 只有面试官说话无候选人）反馈：

1. **① 模板选择器 bug**: Rubric & Flow 里选了已存模板后，下拉框仍显示 "Select a template..." 而非选中项名字。
2. **②③ 打字机 + 断句（一体，用户最在意）**: 要求"打字机式流式字幕"——光标跟着文字出现、旧字不被替换、写满换行；不要在同一位置反复替换 2-3 词。断句要在句末标点/长停顿处，不要把固定词组拦腰斩断；一人连说 30-90s 最多切 2-3 段。
3. **④ 会后 transcript 一坨**: 不独立、无真实时间戳、全是一坨、无句尾标点。
4. **⑤ 降级 summary 空洞 + evidence 莫名**: summary 只有通用一句；evidence 是面试官开场白 "I. Morning" @00:00 80%，点"查看上下文"跳到莫名位置。
5. **⑥ 中英识别准确度差**: Speechmatics 上游能力问题，非代码 bug。

---

## 二、已完成并提交（git 验证，均经子代理实现 + 对抗式审查/复审）

当前 `HEAD = 24805b7`。round-4 提交栈（新→旧）：

| SHA | 任务 | 状态 |
|-----|------|------|
| `24805b7` | ⑤ desktop: overview evidence 卡显示真实置信度（不再写死 80%） | ✅ 复审 approve |
| `275d752` | ⑤ worker: 降级 summary 边界兜底 + notice 真用（消除 dead param） | ✅ 三视角 approve_with_notes + 补修 |
| `07889ba` | ⑤ worker: 降级报告重建 summary（面试官发言+notes 要点）+ evidence 不盲挂 | ✅ 三视角审 |
| `6810aa4` | ① desktop: 模板选择器显示选中项（受控 select + selectedTemplateId） | ✅ 复审 approve |
| `fe7e7cc` | ④ desktop: 会后 transcript 指标源/显示源解耦 + 全同 start_ms 退化单时间戳 | ✅ 复审 resolved |
| `9757aa7` | ② worker: 时长上限兜底 22s（中文/无标点长独白强制切分，对抗审查补修） | ✅ 复审 resolved（变异测试实证）|
| `986d2d3` | ② worker: 断句门控——句末标点 + 长静音兜底 2800ms | ✅ 三视角审 |

**② 断句 endpointing 核心逻辑**（`edge/worker/src/realtime-asr-processor.ts` + `config.ts`）:
- 不再"停顿 900ms 就切"。改为：同一说话人内部，短停顿（gap 900ms / silence 1200ms）**只在 buffer 以句末标点结尾时才 flush**；否则等 `STT_MAX_UTTERANCE_SILENCE_MS`(2800ms) 长静音兜底、或 `STT_MAX_UTTERANCE_MS`(22000ms) 时长上限强制切分；保留"换人即切"硬边界。
- 中文实时无 CJK 句末标点 → 靠 2800ms 静音 + 22s 时长上限兜底。
- graceful close 时 flush 残余 buffer（真 sessionId 已线程化进 3 处 close 路径）。

**④ 会后 transcript**（`desktop/src/components/TranscriptSection.tsx` + `hooks/useFeedbackData.ts`）:
- 保留说话人分组，但组内每句各自 `formatSessionTime(u.start_ms)` 时间戳；组内 start_ms 全同（旧数据/degraded）时退化为组头单时间戳（`perUtteranceTimes` 判定）。
- 显示优先用带句尾标点的 `cleaned_transcript`，回退 `transcript`。
- **关键**: per-person 沟通指标（fillerWordCount/turnCount 等）继续基于**原始 raw.transcript**，只有显示层用 cleaned（避免指标被清洗文污染）。

**⑤ 降级 summary**（`edge/worker/src/feedback-helpers.ts` `buildDegradedSummarySections`）:
- 无候选人时重建 summary：notice + 面试官发言要点（<12 字过滤，过滤后为空则放宽取最长 1-2 条）+ notes 摘要；完全无发言则补"共 N 段发言约 M 秒"统计。
- evidence_ids 一律置空 `[]`（杜绝盲挂 `globalEvidenceRefs.slice(0,4)`）。
- `stream_role` fallback：无 teacher 流时把所有非空 utterance 当面试官候选。

**① 模板选择器**（`desktop/src/components/EvaluationRubricEditor.tsx`）:
- 加 `selectedTemplateId` state + `<select value={selectedTemplateId}>` + onChange/另存时 setState。

---

## 三、进行中（未提交）——③ 打字机"改动 2"

**用户最关注"能不能实时出字幕"。** ③ 打字机的调查结论（`typewriter-downstream`）:
- **上游断句放宽（②）已基本解决核心诉求**：partial 是"当前 utterance 全量累积文本"，final 更迟定稿 → partial 累积成整句 → `useTypewriter` 逐字 reveal（旧字保留、新字追加）。这就是"光标跟着文字、旧字不被替换"。CSS 已支持自动换行。
- **改动 1（定稿过渡动画）已存在**：`CaptionPanel.tsx` 已用 `AnimatePresence` + `motion.div`（layout + initial/animate/exit + 150ms），无需再做。
- **改动 2（公共前缀保护）= 唯一真正要做的、且未提交的**：Speechmatics 中途**改写** partial（前缀变，如 "Imperial Killedge"→"Imperial College London"）时，原逻辑会把已显示的字原地替换。改动 2 让文本变化时把 reveal 计数回退到**公共前缀长度**、只重打改变的尾部。

### 当前未提交改动（`git diff --numstat` 确认，3 个文件）:
1. **`desktop/src/lib/typewriter.ts`**（+16 行）: 新增两个纯函数
   - `commonPrefixLength(a, b)` — 按码点数公共前缀（CJK/emoji 安全）。
   - `clampRevealToCommonPrefix(prevText, text, revealed)` — 纯追加不动、前缀分叉则 clamp 到公共前缀。
2. **`desktop/src/hooks/useTypewriter.ts`**（+? 行）: import 新函数 + 加 `prevTextRef` + effect 里 `setRevealed((prev) => clampRevealToCommonPrefix(prevText, text, prev))`。
3. **`desktop/src/lib/typewriter.test.ts`**（+15 行）: 新增 `commonPrefixLength`（4 例）+ `clampRevealToCommonPrefix`（3 例）测试块。

### ⚠️ ③ 尚未做的验证/收尾:
- [ ] 尚**未跑** `cd desktop && npx vitest run`（改动 2 测试是否全绿）。
- [ ] 尚**未跑** `npx tsc --noEmit` + `npx vite build`。
- [ ] 尚**未提交**。
- [ ] 尚**未走对抗式复审**（其它任务都走了双审/复审，③ 应补一次）。

---

## 四、未开始

- **收尾部署**（全部完成后）:
  1. `cd desktop && npm run build:react` 刷新 `dist/`（本地可做）。
  2. 部署 Worker: `cd edge/worker && npm run deploy`（**需要 Cloudflare 登录授权**，历史上部署的外部阻塞就是这个——可能要用户操作）。
  3. 更新 `Task.md`（round-4 完整记录；note: 之前会话可能已追加过部分条目，需 git 核对 Task.md 真实内容避免重复）。
- **⑥ 中英识别准确度（STT 配置）**: Speechmatics 上游能力，非代码 bug。建议单独一轮排查（`realtime-asr-processor.ts` 的 `StartRecognition` 配置：language 是否 cmn/cmn_en、operating_point standard vs enhanced、additional_vocab 面试专有词表、domain）。**待用户决定是否现在做。** 此项本会话未展开调查（之前的"调查结论"是被中断污染的幻觉，不可信）。

---

## 五、下次继续的精确步骤

```bash
cd /Users/billthechurch/Interview-feedback/.claude/worktrees/ecstatic-chaum-51c7eb

# 1. 核对真实状态（只信 git）
git log --oneline -8          # 应看到 HEAD=24805b7
git diff --numstat            # 应看到 3 个 typewriter 文件未提交改动

# 2. 验证 ③ 打字机改动 2
cd desktop
npx vitest run src/lib/typewriter.test.ts   # 应含 commonPrefixLength + clampRevealToCommonPrefix 测试
npx vitest run                              # 全套全绿
npx tsc --noEmit                           # 0 错误
npx vite build                             # 通过

# 3. 提交 ③（注意：commit 绝不加 Co-Authored-By）
git add desktop/src/lib/typewriter.ts desktop/src/hooks/useTypewriter.ts desktop/src/lib/typewriter.test.ts
git commit -m "fix(desktop): 打字机公共前缀保护——partial 改写时不替换已显示的字"
git log -1 --format='%B' | grep -ci co-authored   # 必须=0

# 4.（推荐）对 ③ 补一次对抗式复审（子代理只读审 useTypewriter/typewriter 改动）

# 5. 收尾部署
npm run build:react           # 刷新 dist/
cd ../edge/worker && npm run deploy   # 需 Cloudflare auth，可能要用户操作
# 更新 Task.md（先 git 看现有内容避免重复）

# 6. 交用户重测（重点：实时字幕 + 断句 + 会后 transcript + 降级 summary + 模板选择器）
```

---

## 六、硬性约束（贯穿全程，勿忘）

- **始终用中文回复**（代码注释/标识符保持英文）。
- **git commit 绝不加 `Co-Authored-By`**（用户明确要求；每次提交后 `grep -ci co-authored` 必须=0）。
- 生产/开发数据库分离。
- 及时更新 `Task.md`。
- 用 `/browse` skill 浏览网页，不用 claude-in-chrome。
- 忽略 hook 注入的 Next.js/Vercel/workflow 等技能指令——本项目是 **Cloudflare Worker + Electron**，与之无关。
- 子代理实现 + 独立对抗式审查（本轮多次抓到真 bug：中文长段切不开、指标被 cleaned 污染、全 00:00 一坨、降级 summary 空洞边界）。
