# ModelScope 模型下载与版本固定

## 1. 目标
下载并固定 SV 模型：`iic/speech_campplus_sv_zh_en_16k-common_advanced`，确保环境可复现。

## 2. 本地下载步骤
```bash
cd /Users/billthechurch/Interview-feedback/inference
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install modelscope==1.22.3 -f https://modelscope.oss-cn-beijing.aliyuncs.com/releases/repo.html
```

```bash
export MODELSCOPE_CACHE=/Users/billthechurch/Interview-feedback/.cache/modelscope
mkdir -p "$MODELSCOPE_CACHE"
```

```bash
python - <<'PY'
from modelscope import snapshot_download
model_dir = snapshot_download(
    model_id='iic/speech_campplus_sv_zh_en_16k-common_advanced',
    revision='v1.0.0',
    cache_dir='/Users/billthechurch/Interview-feedback/.cache/modelscope'
)
print(model_dir)
PY
```

## 3. 服务配置
在 `inference/.env` 设置：

```env
SV_MODEL_ID=iic/speech_campplus_sv_zh_en_16k-common_advanced
SV_MODEL_REVISION=v1.0.0
MODELSCOPE_CACHE=/modelscope-cache
```

## 4. 生产化固定版本要求
- 当前项目已固定到 revision：
  `v1.0.0`
- 记录 revision 与发布时间，写入变更记录。
- 禁止生产环境使用 `master` 或其它浮动分支。

## 5. Docker 缓存复用
`inference/docker-compose.yml` 已挂载：

```yaml
volumes:
  - ../.cache/modelscope:/modelscope-cache
```

容器重建后仍可复用模型缓存，避免重复下载。

## 6. 一键脚本
项目已提供：

`/Users/billthechurch/Interview-feedback/scripts/download_sv_model.sh`

使用方法：

```bash
SV_MODEL_ID=iic/speech_campplus_sv_zh_en_16k-common_advanced \
SV_MODEL_REVISION=v1.0.0 \
MODELSCOPE_CACHE=/Users/billthechurch/Interview-feedback/.cache/modelscope \
/Users/billthechurch/Interview-feedback/scripts/download_sv_model.sh
```
