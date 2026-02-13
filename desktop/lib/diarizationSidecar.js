const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function splitArgs(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDiarizationSidecar({ appRoot, log }) {
  const state = {
    process: null,
    status: 'stopped',
    startedAt: null,
    lastError: null,
    binaryPath: null,
    host: '127.0.0.1',
    port: 9705,
    endpoint: '/diarize',
    restartCount: 0,
    maxRestarts: 4,
    restartBackoffMs: 1200,
    restartTimer: null,
    restartInFlight: false,
    stopRequested: false,
    lastStartOptions: {}
  };

  function endpointUrl(pathname) {
    return `http://${state.host}:${state.port}${pathname}`;
  }

  async function waitUntilHealthy(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(endpointUrl('/health'), { method: 'GET' });
        if (response.ok) {
          return;
        }
      } catch {
        // continue polling
      }
      await sleep(250);
    }
    throw new Error(`pyannote sidecar health timeout ${timeoutMs}ms`);
  }

  async function start(options = {}) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error(
        `pyannote sidecar supports macOS arm64 only (current platform=${process.platform}, arch=${process.arch})`
      );
    }
    if (state.process && !state.process.killed) {
      return status();
    }
    state.stopRequested = false;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }

    const binaryPath =
      options.binaryPath ||
      process.env.PYANNOTE_RS_BIN ||
      path.join(appRoot, 'bin', 'pyannote-rs');
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`pyannote sidecar binary not found: ${binaryPath}`);
    }

    state.host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
    state.port = Number.isFinite(Number(options.port)) ? Number(options.port) : 9705;
    state.endpoint = typeof options.endpoint === 'string' && options.endpoint ? options.endpoint : '/diarize';
    state.binaryPath = binaryPath;
    state.lastStartOptions = {
      binaryPath: options.binaryPath,
      host: options.host,
      port: options.port,
      endpoint: options.endpoint,
      timeoutMs: options.timeoutMs
    };

    const argsFromEnv = splitArgs(process.env.PYANNOTE_RS_ARGS);
    const args = argsFromEnv.length > 0 ? argsFromEnv : ['serve', '--host', state.host, '--port', String(state.port)];

    log(`[sidecar] starting binary=${binaryPath} args=${JSON.stringify(args)}`);
    const child = spawn(binaryPath, args, {
      cwd: path.dirname(binaryPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    state.process = child;
    state.status = 'starting';
    state.startedAt = new Date().toISOString();
    state.lastError = null;

    child.stdout.on('data', (buf) => {
      log(`[sidecar][stdout] ${String(buf).trim()}`);
    });
    child.stderr.on('data', (buf) => {
      log(`[sidecar][stderr] ${String(buf).trim()}`);
    });

    child.on('exit', (code, signal) => {
      state.status = 'stopped';
      state.process = null;
      state.lastError = `sidecar exited code=${code} signal=${signal || 'none'}`;
      log(`[sidecar] exited code=${code} signal=${signal || 'none'}`);
      if (!state.stopRequested) {
        scheduleRestart(`exit:${code}:${signal || 'none'}`);
      }
    });

    try {
      const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 20000;
      await waitUntilHealthy(timeoutMs);
      state.status = 'running';
      state.restartCount = 0;
      log('[sidecar] healthy');
      return status();
    } catch (error) {
      state.lastError = error?.message || String(error);
      state.status = 'error';
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  function scheduleRestart(reason) {
    if (state.stopRequested) return;
    if (state.restartInFlight) return;
    if (state.restartTimer) return;
    if (state.restartCount >= state.maxRestarts) {
      state.status = 'error';
      state.lastError = `auto-restart exhausted after ${state.maxRestarts} attempts; reason=${reason}`;
      log(`[sidecar] auto-restart exhausted reason=${reason}`);
      return;
    }
    state.restartCount += 1;
    const delayMs = state.restartBackoffMs * state.restartCount;
    state.restartTimer = setTimeout(async () => {
      state.restartTimer = null;
      if (state.stopRequested) return;
      state.restartInFlight = true;
      try {
        log(`[sidecar] auto-restart attempt=${state.restartCount} reason=${reason}`);
        await start(state.lastStartOptions || {});
      } catch (error) {
        state.lastError = `auto-restart failed: ${error?.message || String(error)}`;
        log(`[sidecar] auto-restart failed: ${state.lastError}`);
        scheduleRestart('auto-restart-failed');
      } finally {
        state.restartInFlight = false;
      }
    }, delayMs);
  }

  async function stop() {
    state.stopRequested = true;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (!state.process) {
      state.status = 'stopped';
      return status();
    }
    const proc = state.process;
    state.status = 'stopping';
    try {
      proc.kill('SIGTERM');
    } catch {
      // noop
    }
    await sleep(500);
    if (state.process) {
      try {
        state.process.kill('SIGKILL');
      } catch {
        // noop
      }
    }
    state.process = null;
    state.status = 'stopped';
    state.restartCount = 0;
    return status();
  }

  async function health() {
    try {
      const response = await fetch(endpointUrl('/health'));
      if (!response.ok && !state.stopRequested) {
        scheduleRestart(`health:${response.status}`);
      }
      return response.ok;
    } catch {
      if (!state.stopRequested) {
        scheduleRestart('health-network-error');
      }
      return false;
    }
  }

  async function pushWindow(payload) {
    if (!state.process || state.status !== 'running') {
      throw new Error('pyannote sidecar is not running');
    }
    const response = await fetch(endpointUrl(state.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`sidecar diarize failed: status=${response.status} body=${JSON.stringify(data).slice(0, 240)}`);
    }
    return data;
  }

  function status() {
    return {
      status: state.status,
      startedAt: state.startedAt,
      lastError: state.lastError,
      host: state.host,
      port: state.port,
      endpoint: state.endpoint,
      binaryPath: state.binaryPath,
      pid: state.process?.pid || null
    };
  }

  return {
    start,
    stop,
    status,
    health,
    pushWindow
  };
}

module.exports = {
  createDiarizationSidecar
};
