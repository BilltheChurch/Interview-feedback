# 开工行动清单｜MVP-A（从零开始，详细版）｜v2.0

**更新日期**：2026-02-11（Asia/Taipei）  
**目标**：今天先把本地 inference（Docker）跑通 + 回归脚本通过。

---

## 0. 你现在先别做什么
- 别先搭 Cloudflare（没有 inference 无法验证）
- 别先做桌面端 UI（联调成本最高）
- 别先选 diarization 模型（先保留插入点）

---

## 1. 建仓库与目录（30 分钟）
- `docs/` 放 6 份 md（保持原名）
- `inference/`、`scripts/`、`samples/` 创建并提交

验收：git 提交完成。

---

## 2. 准备最小回归音频（1 小时）
2 人 ×（enroll + probe）4 段音频，统一 16k mono PCM16。

验收：ffprobe 正确。

---

## 3. 推理服务（FastAPI + Docker）（2–6 小时）
### 3.1 接口顺序
1) /health  
2) /sv/extract_embedding  
3) /sv/score  
4) /speaker/resolve  
5) /sd/diarize（预留 501）

### 3.2 模块最低实现
- normalize：强制 16k mono PCM16
- VAD：能切段
- SV：固定模型 `iic/speech_campplus_sv_zh_en_16k-common_advanced`
- clustering：centroid 阈值
- name resolver：规则抽取（my name is / i'm / i am）
- binder：阈值策略 auto/confirm/unknown + evidence

验收：服务启动 + 返回 embedding dim。

---

## 4. Smoke tests（必须）
`scripts/smoke_sv.py`：
- enroll 两人
- probe 两人
- 模拟 asr_text 触发绑定
- 输出 cluster_id/decision/evidence

验收：脚本退出 0；Top-1 命中正确。

---

## 5. ASR smoke（可选但建议）
DashScope key 可用后跑 `smoke_asr_dashscope.py`。

---

## 6. 下一步（通过后再做）
- Worker 转发
- DO 会话状态
- R2 存档
- Electron 采集
