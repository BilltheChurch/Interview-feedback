# Sample Audio Requirements

Required files for smoke test:

- `alice_enroll.wav`
- `alice_probe.wav`
- `bob_enroll.wav`
- `bob_probe.wav`

Audio constraints:

- sample rate: 16kHz
- channel: mono
- codec: PCM16 (`pcm_s16le`)

## Quick generation workflow

If you have one long raw recording for each speaker:

```bash
# Alice: take 0-6s as enroll, 12-18s as probe
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh \
  alice /path/to/alice_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples

# Bob
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh \
  bob /path/to/bob_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples
```

If you only need one-off format normalization:

```bash
/Users/billthechurch/Interview-feedback/scripts/prepare_samples.sh <input_audio> <output.wav>
```

Validate the full sample set:

```bash
/Users/billthechurch/Interview-feedback/scripts/validate_samples.sh \
  /Users/billthechurch/Interview-feedback/samples
```
