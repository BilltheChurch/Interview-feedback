#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <input_audio> <output_wav>"
  exit 1
fi

input_audio="$1"
output_wav="$2"

ffmpeg -hide_banner -loglevel error -y -i "$input_audio" -ar 16000 -ac 1 -c:a pcm_s16le "$output_wav"
ffprobe -v error -show_entries stream=sample_rate,channels,codec_name -of default=noprint_wrappers=1 "$output_wav"
