const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { app } = require('electron');

function resolveFFmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg-static', 'ffmpeg');
  }
  return require('ffmpeg-static');
}

function resolveFFprobePath() {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'ffprobe-static', 'bin');
    // ffprobe-static stores binary in bin/{platform}/{arch}/ffprobe
    return path.join(base, process.platform, process.arch, 'ffprobe');
  }
  return require('ffprobe-static').path;
}

const ffmpegPath = resolveFFmpegPath();
const ffprobePath = resolveFFprobePath();

const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1;
const TARGET_CODEC = 'pcm_s16le';

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(new Error(`failed to start command ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`command failed (${command} ${args.join(' ')}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  return 'bin';
}

function safeMeetingId(meetingId) {
  const raw = String(meetingId || 'local-smoke').trim();
  if (!raw) return 'local-smoke';
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

async function ensureDir(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
}

async function normalizeAudioFile(inputPath, outputPath) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not resolve a usable ffmpeg binary');
  }

  const args = [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    String(TARGET_CHANNELS),
    '-ar',
    String(TARGET_SAMPLE_RATE),
    '-acodec',
    TARGET_CODEC,
    '-f',
    'wav',
    outputPath
  ];

  await runCommand(ffmpegPath, args);
}

async function probeAudioFile(targetPath) {
  if (!ffprobePath) {
    throw new Error('ffprobe-static did not resolve a usable ffprobe binary');
  }

  const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', targetPath];
  const { stdout } = await runCommand(ffprobePath, args);

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`failed to parse ffprobe output: ${error.message}`);
  }

  const stream = (payload.streams || []).find((item) => item.codec_type === 'audio');
  if (!stream) {
    throw new Error('ffprobe did not return an audio stream');
  }

  return {
    codecName: stream.codec_name || '',
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0),
    durationSec: Number(stream.duration || payload.format?.duration || 0)
  };
}

function validateAudioMetadata(metadata) {
  const checks = {
    codec: metadata.codecName === TARGET_CODEC,
    sampleRate: metadata.sampleRate === TARGET_SAMPLE_RATE,
    channels: metadata.channels === TARGET_CHANNELS,
    duration: metadata.durationSec > 0
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks
  };
}

async function finalizeRecording({ rawBytes, mimeType, meetingId, outputDir }) {
  if (!rawBytes || rawBytes.byteLength === 0) {
    throw new Error('rawBytes is empty');
  }

  const meetingSafe = safeMeetingId(meetingId);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const ext = extensionFromMimeType(mimeType);

  const rootDir = outputDir || path.join(process.cwd(), 'desktop-recordings');
  const sessionDir = path.join(rootDir, meetingSafe);
  await ensureDir(sessionDir);

  const rawPath = path.join(sessionDir, `${stamp}.raw.${ext}`);
  const normalizedPath = path.join(sessionDir, `${stamp}.16k_mono_pcm16.wav`);

  const payloadBuffer = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  await fs.writeFile(rawPath, payloadBuffer);

  await normalizeAudioFile(rawPath, normalizedPath);
  const metadata = await probeAudioFile(normalizedPath);
  const validation = validateAudioMetadata(metadata);

  return {
    rawPath,
    normalizedPath,
    metadata,
    validation
  };
}

async function normalizeFromFile({ inputPath, meetingId, outputDir }) {
  const meetingSafe = safeMeetingId(meetingId);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  const rootDir = outputDir || path.join(process.cwd(), 'desktop-recordings');
  const sessionDir = path.join(rootDir, meetingSafe);
  await ensureDir(sessionDir);

  const normalizedPath = path.join(sessionDir, `${stamp}.16k_mono_pcm16.wav`);
  await normalizeAudioFile(inputPath, normalizedPath);

  const metadata = await probeAudioFile(normalizedPath);
  const validation = validateAudioMetadata(metadata);

  return {
    sourcePath: inputPath,
    normalizedPath,
    metadata,
    validation
  };
}

module.exports = {
  TARGET_SAMPLE_RATE,
  TARGET_CHANNELS,
  TARGET_CODEC,
  finalizeRecording,
  normalizeFromFile,
  probeAudioFile,
  validateAudioMetadata
};
