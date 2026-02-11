#!/usr/bin/env bash
set -euo pipefail

samples_dir="${1:-/Users/billthechurch/Interview-feedback/samples}"
required=("alice_enroll.wav" "alice_probe.wav" "bob_enroll.wav" "bob_probe.wav")

status=0

for file in "${required[@]}"; do
  path="${samples_dir}/${file}"
  if [[ ! -f "$path" ]]; then
    echo "[MISSING] $path"
    status=1
    continue
  fi

  codec="$(ffprobe -v error -show_entries stream=codec_name -of default=nw=1:nk=1 "$path")"
  sr="$(ffprobe -v error -show_entries stream=sample_rate -of default=nw=1:nk=1 "$path")"
  ch="$(ffprobe -v error -show_entries stream=channels -of default=nw=1:nk=1 "$path")"
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$path")"

  if [[ "$codec" != "pcm_s16le" || "$sr" != "16000" || "$ch" != "1" ]]; then
    echo "[INVALID] $path codec=$codec sr=$sr ch=$ch dur=${dur}s"
    status=1
  else
    echo "[OK] $path codec=$codec sr=$sr ch=$ch dur=${dur}s"
  fi
done

exit "$status"
