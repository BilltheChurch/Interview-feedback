#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

function argValue(name, fallback = undefined) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

const sessionId = argValue("--session-id");
if (!sessionId) {
  console.error("usage: node scripts/export_r2_session_audio.mjs --session-id <id> [--bucket interview-feedback-results] [--base-url https://api.frontierace.ai] [--out-dir ./artifacts]");
  process.exit(1);
}

const bucket = argValue("--bucket", "interview-feedback-results");
const baseUrl = argValue("--base-url", "https://api.frontierace.ai").replace(/\/+$/, "");
const outDirArg = argValue("--out-dir", path.resolve(process.cwd(), "artifacts", "r2-export"));
const wranglerCwd = argValue("--wrangler-cwd", path.resolve(process.cwd(), "edge", "worker"));
const outDir = path.resolve(outDirArg);

function runCommand(cmd, commandArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new Error(`failed to launch ${cmd}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${commandArgs.join(" ")} failed: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function toSeqKey(session, seq) {
  return `sessions/${session}/chunks/${String(seq).padStart(8, "0")}.pcm`;
}

function writeWavHeader(pcmBytes, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

async function fetchState() {
  const resp = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/state`);
  if (!resp.ok) {
    throw new Error(`state request failed: HTTP ${resp.status}`);
  }
  const payload = await resp.json();
  if (!payload.ingest) {
    throw new Error("state response missing ingest section");
  }
  return payload;
}

async function downloadChunks(lastSeq, chunksDir) {
  const missing = [];
  let downloaded = 0;

  const existingFiles = (await fs.readdir(chunksDir)).filter((item) => item.endsWith(".pcm"));
  await Promise.all(existingFiles.map((name) => fs.unlink(path.join(chunksDir, name))));

  for (let seq = 1; seq <= lastSeq; seq += 1) {
    const key = toSeqKey(sessionId, seq);
    const filePath = path.join(chunksDir, `${String(seq).padStart(8, "0")}.pcm`);

    try {
      await runCommand(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "get",
          `${bucket}/${key}`,
          "--remote",
          "--file",
          filePath
        ],
        wranglerCwd
      );
      const stat = await fs.stat(filePath);
      if (stat.size !== 32000) {
        await fs.unlink(filePath);
        missing.push(seq);
        continue;
      }
      downloaded += 1;
      if (downloaded % 50 === 0) {
        console.log(`downloaded ${downloaded}/${lastSeq} chunks`);
      }
    } catch {
      missing.push(seq);
    }
  }

  return { downloaded, missing };
}

async function mergeToWav(chunksDir, outputWav) {
  const files = (await fs.readdir(chunksDir))
    .filter((item) => item.endsWith(".pcm"))
    .sort();

  const pcmBuffers = [];
  let totalBytes = 0;
  for (const file of files) {
    const payload = await fs.readFile(path.join(chunksDir, file));
    if (payload.byteLength !== 32000) {
      continue;
    }
    pcmBuffers.push(payload);
    totalBytes += payload.byteLength;
  }

  const header = writeWavHeader(totalBytes);
  const output = Buffer.concat([header, ...pcmBuffers], header.byteLength + totalBytes);
  await fs.writeFile(outputWav, output);
  return { fileCount: files.length, totalBytes };
}

async function main() {
  const state = await fetchState();
  const ingest = state.ingest;
  const lastSeq = Number(ingest.last_seq || 0);
  if (!Number.isInteger(lastSeq) || lastSeq <= 0) {
    throw new Error(`invalid ingest.last_seq: ${lastSeq}`);
  }

  const sessionDir = path.join(outDir, sessionId);
  const chunksDir = path.join(sessionDir, "chunks");
  const wavPath = path.join(sessionDir, `${sessionId}.wav`);
  await fs.mkdir(chunksDir, { recursive: true });

  console.log(`session=${sessionId} last_seq=${lastSeq} missing_server=${ingest.missing_chunks} duplicate_server=${ingest.duplicate_chunks}`);
  const { downloaded, missing } = await downloadChunks(lastSeq, chunksDir);

  const { fileCount, totalBytes } = await mergeToWav(chunksDir, wavPath);
  const durationSec = totalBytes / 32000;

  const report = {
    session_id: sessionId,
    output_wav: wavPath,
    server_last_seq: lastSeq,
    server_missing_chunks: ingest.missing_chunks,
    server_duplicate_chunks: ingest.duplicate_chunks,
    downloaded_chunks: downloaded,
    local_missing_chunks: missing.length,
    local_missing_seq_preview: missing.slice(0, 20),
    merged_chunk_files: fileCount,
    pcm_bytes: totalBytes,
    duration_sec: Number(durationSec.toFixed(3))
  };

  const reportPath = path.join(sessionDir, "export_report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`export_r2_session_audio failed: ${error.message}`);
  process.exit(1);
});
