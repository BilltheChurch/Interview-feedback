# Desktop UI 重设计 — 液态玻璃 (Midnight Vibrancy) 设计文档

Status: In Progress
Created: 2026-06-29
Owner: 总统大人 / Claude

> 把 Chorus 桌面端(Electron + React + Vite + Tailwind v4)重设计为 **Apple 原生暗色"液态玻璃"** 风格:
> 半透明模糊玻璃面板、靛蓝→青强调渐变、克制但有活力的动效。经可视化 mockup 对比,选定 **Midnight vibrancy(暗色)** 方向。

## 锁定决策(2026-06-29 brainstorm)
- **方向**:Midnight vibrancy 暗色玻璃。主强调色 **靛蓝 `#7c6bff` → 青 `#21d4fd`**(替代旧 teal `#0D6A63`)。
- **范围**:先把 **Home** 做成可运行成品(建立设计语言)→ 用户在真 app 验收 → 再用同一套语言推广 Setup/Sidecar/Feedback/History/Settings。
- **模式**:暗色优先(亮色模式作后续增量)。
- **动效**:克制的 Apple 风(入场淡入+位移、hover 微抬、指针光晕、漂浮模糊光斑),全局尊重 `prefers-reduced-motion`。
- **IA/功能不变**:只换皮 + 动效,不改信息架构与业务流程。

## 架构策略(关键)
所有视图都使用语义 Tailwind token(`bg-bg`/`text-ink`/`bg-surface`/`border-border`/`text-accent`)。因此:
1. **token 翻暗**:在 `globals.css` 的 `@theme` 把 `--color-*` 改为暗色液态玻璃调色板 → 整窗一次性协调变暗,其余 5 视图自动变暗(不破版),无亮/暗接缝。
2. **玻璃组件层**(新增 `components/ui/`):`GlassCard`、`GlassScene`(暗色场景渐变 + 漂浮模糊光斑背景)、`SegmentedControl`(1v1/Group)、Button 新增 `glass`/渐变 primary 变体。复用现有 Card/Button/TextField API。
3. **Home 重写**:用玻璃组件 + `motion/react` 重写 HomeView(对齐选定 mockup)。
4. **Electron 真玻璃**:`BrowserWindow` 开 macOS `vibrancy`(透明窗 + `under-window`)+ CSS `backdrop-filter` 叠加。
5. **推广**:其余视图逐个把 Card→GlassCard、加 motion variants + 场景,token 已暗,改动是"加质感"而非"重排版"。

## 暗色玻璃 token(globals.css）
- 场景:`--color-bg` 深炭黑渐变基色;`GlassScene` 提供径向渐变 + 3 个 `blur(60px)` 漂浮光斑(`@keyframes glass-drift`)。
- 玻璃:`--color-glass: rgba(28,29,44,0.55)`、`--color-glass-border: rgba(255,255,255,0.14)`、`backdrop-filter: blur(20px) saturate(1.4)`、1px 顶部高光(inset)。
- 文本:`--color-ink #f4f5ff` / secondary `#a9aecb` / tertiary `#7a7f9c`。
- 强调:`--color-accent #7c6bff`、`--gradient-accent linear-gradient(120deg,#8b7bff,#36dcff)`、`--color-accent-2 #21d4fd`。
- 圆角沿用(card 16–18px),阴影改为暗色景深 + inset 高光。

## 验收
- `npm run dev` 真机:Home 呈现暗色液态玻璃 + 动效,功能与改前一致(开始 session / 日历 / pending feedback 正常)。
- `npx tsc --noEmit` + `npx vite build` 通过;`prefers-reduced-motion` 下动效退化。
- 其余视图暗色协调(不破版),玻璃精修留待推广阶段。
