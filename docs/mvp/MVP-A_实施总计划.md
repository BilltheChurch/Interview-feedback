# MVP-A 实施总计划

## 1. 目标
在本地完成可运行的推理编排服务：VAD + SV 在线聚类 + 姓名抽取绑定，并保留 Diarization 可插拔接口。

## 2. 范围
- 包含：`/health`、`/sv/extract_embedding`、`/sv/score`、`/speaker/resolve`、`/sd/diarize(501)`。
- 包含：Docker 封装、本地回归脚本、Cloudflare Tunnel 公网联调文档。
- 不包含：Worker/DO/R2 正式接入、真实 diarization 推理实现。

## 3. 阶段拆分
### Phase 0
- 固化 API Contract 与 schema
- 固化环境变量与阈值配置

### Phase 1
- 音频规范化：输入统一为 16kHz/mono/PCM16
- VAD 分段
- SV embedding 与 score
- 在线聚类
- 姓名抽取与绑定决策

### Phase 2
- Docker 可运行，支持模型缓存卷
- `/health` 返回模型信息与阈值

### Phase 3
- 本地服务通过 Cloudflare Tunnel 暴露 HTTPS

### Phase 4
- 2 人 4 段音频 smoke 回归
- 输出 Top-1 与 resolve decision/evidence

## 4. 关键工程原则
- 模型版本必须配置化，禁止硬编码。
- 所有阈值必须可配且可观测。
- Diarization 必须接口化，不侵入上层 resolve 契约。

## 5. 交付清单
- `inference/` 服务代码与 Docker 文件
- `scripts/smoke_sv.py` 与 `scripts/prepare_samples.sh`
- `docs/mvp` 下 API、ModelScope、Tunnel、测试验收文档
