#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <speaker_name> <input_audio> [enroll_start_s] [probe_start_s] [clip_duration_s] [output_dir]"
  exit 1
fi

speaker_name="$1"
input_audio="$2"
enroll_start="${3:-0}"
probe_start="${4:-12}"
clip_duration="${5:-6}"
out_dir="${6:-/Users/billthechurch/Interview-feedback/samples}"

mkdir -p "$out_dir"

enroll_out="${out_dir}/${speaker_name}_enroll.wav"
probe_out="${out_dir}/${speaker_name}_probe.wav"

ffmpeg -hide_banner -loglevel error -y -ss "$enroll_start" -t "$clip_duration" -i "$input_audio" -ar 16000 -ac 1 -c:a pcm_s16le "$enroll_out"
ffmpeg -hide_banner -loglevel error -y -ss "$probe_start" -t "$clip_duration" -i "$input_audio" -ar 16000 -ac 1 -c:a pcm_s16le "$probe_out"

echo "Generated:"
echo "  $enroll_out"
echo "  $probe_out"

ffprobe -v error -show_entries stream=sample_rate,channels,codec_name -of default=nw=1:nk=1 "$enroll_out" | sed 's/^/enroll: /'
ffprobe -v error -show_entries stream=sample_rate,channels,codec_name -of default=nw=1:nk=1 "$probe_out" | sed 's/^/probe:  /'
