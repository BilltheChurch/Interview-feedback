# 本地 Docker 与 Cloudflare Tunnel 联调手册

## 1. 启动推理服务

```bash
cd /Users/billthechurch/Interview-feedback/inference
cp .env.production .env
docker compose up --build -d
```

验证：

```bash
curl -s http://localhost:8000/health | jq
```

## 2. 临时公网暴露（快速联调）

先安装并登录 `cloudflared`：

```bash
brew install cloudflared
cloudflared tunnel login
```

临时暴露：

```bash
cloudflared tunnel --url http://localhost:8000
```

命令会返回一个临时 `https://*.trycloudflare.com` 地址。

## 3. 固定公网入口（生产推荐）

### 3.1 通过脚本创建/复用命名 tunnel

```bash
cd /Users/billthechurch/Interview-feedback
./scripts/cloudflare_tunnel_bootstrap.sh \
  --name interview-inference \
  --hostname api.<your-domain> \
  --origin http://localhost:8000 \
  --config /Users/billthechurch/Interview-feedback/cloudflare/tunnel/config.yml
```

脚本会执行：
- 创建或复用命名 tunnel
- 绑定 DNS `api.<your-domain>`
- 生成 `cloudflare/tunnel/config.yml`

### 3.2 启动命名 tunnel

```bash
cd /Users/billthechurch/Interview-feedback
./scripts/cloudflare_tunnel_run.sh --config /Users/billthechurch/Interview-feedback/cloudflare/tunnel/config.yml
```

### 3.3 验证固定域名

```bash
curl -sS https://api.<your-domain>/health | jq
```

## 4. 运维建议

- 外部系统统一访问固定域名，不再依赖 `trycloudflare` 临时地址。
- 推理服务继续只监听 `localhost:8000`，不直接暴露公网端口。
- 在 `inference/.env.production` 设置 `INFERENCE_API_KEY`，Worker/客户端必须携带 `x-api-key`。
- 线上建议同时启用：`MAX_REQUEST_BODY_BYTES`、`RATE_LIMIT_*`。

## 5. 常见问题

- `cloudflared tunnel list` 失败：先执行 `cloudflared tunnel login`。
- 固定域名不可访问：检查 DNS route 是否已指向对应 tunnel。
- `/health` 变慢：模型首次加载与本地缓存初始化通常会有冷启动延迟。
- 识别不稳：先执行样例检查，保证输入为 16kHz/mono/PCM16。
