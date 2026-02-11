# Interview Feedback MVP-A

This repository implements the MVP-A inference orchestrator for real-time interview recording:

- FastAPI inference service (`inference/`)
- Source product docs snapshot (`docs/source/`)
- Project execution docs (`docs/mvp/`)
- Smoke/regression scripts (`scripts/`)
- Local sample audio folder (`samples/`)

## Start Inference Service

```bash
cd /Users/billthechurch/Interview-feedback/inference
cp .env.example .env
docker compose up --build
```

## Run Smoke Test

```bash
python /Users/billthechurch/Interview-feedback/scripts/smoke_sv.py \
  --base-url http://localhost:8000 \
  --samples /Users/billthechurch/Interview-feedback/samples
```

## Prepare Sample Audio

```bash
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh alice /path/to/alice_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh bob /path/to/bob_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples
/Users/billthechurch/Interview-feedback/scripts/validate_samples.sh /Users/billthechurch/Interview-feedback/samples
```
