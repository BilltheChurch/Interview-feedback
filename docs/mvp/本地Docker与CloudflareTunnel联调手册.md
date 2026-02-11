# 本地 Docker 与 Cloudflare Tunnel 联调手册

## 1. 启动推理服务
```bash
cd /Users/billthechurch/Interview-feedback/inference
cp .env.example .env
docker compose up --build
```

验证：
```bash
curl -s http://localhost:8000/health | jq
```

## 2. 临时公网暴露
先安装 `cloudflared`（macOS）：

```bash
brew install cloudflared
```

安装并登录后执行：

```bash
cloudflared tunnel --url http://localhost:8000
```

命令会返回一个临时 `https://*.trycloudflare.com` 地址。

## 3. 联调建议
- 外部系统仅访问 tunnel HTTPS 地址。
- 本机仅保留 `localhost:8000`，不对外直接暴露端口。
- 先联调 `/health` 和 `/speaker/resolve`，再联调完整业务。

## 4. 固定域名（稳定阶段）
1. 创建命名 tunnel：`cloudflared tunnel create <name>`
2. 绑定 DNS：`cloudflared tunnel route dns <name> api.<your-domain>`
3. 配置 ingress 到 `http://localhost:8000`
4. 以服务方式常驻运行 tunnel

## 5. 常见问题
- 502/超时：先确认 `localhost:8000/health` 正常。
- 首次请求慢：模型首次加载耗时属于正常现象。
- 识别不稳：先检查音频是否满足 16k mono PCM16。
