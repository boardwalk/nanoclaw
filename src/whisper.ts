import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import readline from 'readline';

import { logger } from './logger.js';

const TRANSCRIBE_TIMEOUT = 120_000; // 120s per request
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_WINDOW = 60_000; // 60s

let whisperProcess: ChildProcess | null = null;
let ready = false;
let pendingRequests = new Map<
  string,
  { resolve: (text: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let requestCounter = 0;
let restartAttempts: number[] = []; // timestamps of recent restart attempts
let circuitBroken = false;
let whisperModel = 'medium';

export function isWhisperReady(): boolean {
  return ready && whisperProcess !== null && !circuitBroken;
}

export async function startWhisper(model?: string): Promise<void> {
  if (model) whisperModel = model;
  await spawnWhisper();
}

export function stopWhisper(): void {
  ready = false;
  circuitBroken = true; // Prevent auto-restart during shutdown

  // Reject all pending requests
  for (const [id, req] of pendingRequests) {
    clearTimeout(req.timer);
    req.reject(new Error('Whisper server stopping'));
  }
  pendingRequests.clear();

  if (whisperProcess) {
    whisperProcess.kill('SIGTERM');
    whisperProcess = null;
    logger.info('Whisper server stopped');
  }
}

export function transcribe(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ready || !whisperProcess || circuitBroken) {
      reject(new Error('Whisper server not ready'));
      return;
    }

    const id = `req-${++requestCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Whisper transcription timed out'));
    }, TRANSCRIBE_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer });

    const request = JSON.stringify({ id, file: filePath }) + '\n';
    whisperProcess.stdin!.write(request);
  });
}

async function spawnWhisper(): Promise<void> {
  if (circuitBroken) {
    logger.warn('Whisper circuit breaker open, not restarting');
    return;
  }

  // Check restart rate
  const now = Date.now();
  restartAttempts = restartAttempts.filter((t) => now - t < RESTART_WINDOW);
  if (restartAttempts.length >= MAX_RESTART_ATTEMPTS) {
    circuitBroken = true;
    logger.error(
      `Whisper server crashed ${MAX_RESTART_ATTEMPTS} times in ${RESTART_WINDOW / 1000}s, circuit breaker open`,
    );
    return;
  }
  restartAttempts.push(now);

  ready = false;
  const scriptPath = path.resolve(
    import.meta.dirname,
    '..',
    'scripts',
    'whisper-server.py',
  );

  logger.info({ model: whisperModel }, 'Starting Whisper server');

  const proc = spawn('python3', [scriptPath], {
    env: { ...process.env, WHISPER_MODEL: whisperModel },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  whisperProcess = proc;

  // Parse stderr for logging
  const stderrRl = readline.createInterface({ input: proc.stderr! });
  stderrRl.on('line', (line) => {
    logger.debug({ source: 'whisper' }, line);
  });

  // Parse stdout JSON lines
  const stdoutRl = readline.createInterface({ input: proc.stdout! });
  stdoutRl.on('line', (line) => {
    try {
      const data = JSON.parse(line);

      if (data.ready) {
        ready = true;
        // Reset restart tracking on successful startup
        restartAttempts = [];
        logger.info('Whisper server ready');
        return;
      }

      const id = data.id;
      if (!id) return;

      const pending = pendingRequests.get(id);
      if (!pending) return;

      pendingRequests.delete(id);
      clearTimeout(pending.timer);

      if (data.error) {
        pending.reject(new Error(data.error));
      } else {
        pending.resolve(data.text || '');
      }
    } catch (err) {
      logger.warn({ line }, 'Failed to parse Whisper server output');
    }
  });

  proc.on('error', (err) => {
    logger.error({ err }, 'Whisper server process error');
    ready = false;
    whisperProcess = null;
    rejectAllPending('Whisper server process error');
    spawnWhisper();
  });

  proc.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Whisper server exited');
    ready = false;
    whisperProcess = null;
    rejectAllPending('Whisper server exited');

    if (!circuitBroken) {
      // Auto-restart after a brief delay
      setTimeout(() => spawnWhisper(), 2000);
    }
  });
}

function rejectAllPending(reason: string): void {
  for (const [id, req] of pendingRequests) {
    clearTimeout(req.timer);
    req.reject(new Error(reason));
  }
  pendingRequests.clear();
}
