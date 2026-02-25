import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Store } from "./storage.js";

const DEFAULT_PORTLESS_PROXY_PORT = 1355;
const DEFAULT_HEALTH_TIMEOUT_MS = 700;
const DEFAULT_HEALTH_ATTEMPTS = 3;
const HEALTH_RETRY_DELAY_MS = 160;
const LOCK_RECHECK_MS = 200;
const LOCK_WAIT_TIMEOUT_MS = 12_000;
const STARTUP_TIMEOUT_MS = 12_000;
const STARTUP_POLL_MS = 250;

type FetchFn = typeof fetch;
type SpawnFn = typeof spawn;
type SleepFn = (ms: number) => Promise<void>;

interface RuntimeDeps {
  fetchFn: FetchFn;
  spawnFn: SpawnFn;
  sleepFn: SleepFn;
}

const runtime: RuntimeDeps = {
  fetchFn: fetch.bind(globalThis),
  spawnFn: spawn,
  sleepFn: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

interface HealthOptions {
  attempts?: number;
  timeoutMs?: number;
}

export interface EnsureManagedLiveSessionResult {
  url: string;
  started: boolean;
}

function lockPathForGame(store: Store, gameId: string): string {
  return path.join(store.dataDir, "live-locks", `${gameId}.lock`);
}

function getPortlessCommand(): string {
  return process.platform === "win32" ? "portless.cmd" : "portless";
}

function buildPortlessInvocation(gameId: string): { command: string; args: string[] } {
  const route = makeRouteName(gameId);
  const scriptPath = process.argv[1];
  const common = ["live", gameId, "--no-open", "--poll-ms", "1500"];

  if (scriptPath && scriptPath.endsWith(".js")) {
    return {
      command: getPortlessCommand(),
      args: [route, "node", scriptPath, ...common],
    };
  }

  return {
    command: getPortlessCommand(),
    args: [route, "npm", "run", "dev", "--", ...common],
  };
}

async function tryAcquireLock(lockPath: string): Promise<FileHandle | null> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    const maybe = error as NodeJS.ErrnoException;
    if (maybe?.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function releaseLock(lockPath: string, handle: FileHandle | null): Promise<void> {
  if (handle) {
    try {
      await handle.close();
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    await rm(lockPath, { force: true });
  } catch {
    // ignore cleanup errors
  }
}

function launchManagedProcess(gameId: string): ChildProcess {
  const invocation = buildPortlessInvocation(gameId);
  const child = runtime.spawnFn(invocation.command, invocation.args, {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.on("error", () => {
    // detached launch is best-effort; health check handles failures
  });
  child.unref();
  return child;
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLiveHealthy(url, { attempts: 1, timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS })) {
      return true;
    }
    await runtime.sleepFn(STARTUP_POLL_MS);
  }
  return false;
}

export function makeRouteName(gameId: string): string {
  const normalized = gameId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return `agentchess-${normalized || "game"}`;
}

export function getPortlessProxyPort(): number {
  const raw = process.env.PORTLESS_PORT?.trim();
  if (!raw) {
    return DEFAULT_PORTLESS_PROXY_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORTLESS_PROXY_PORT;
  }
  return parsed;
}

export function getManagedLiveUrl(gameId: string): string {
  const route = makeRouteName(gameId);
  return `http://${route}.localhost:${getPortlessProxyPort()}/`;
}

export async function isLiveHealthy(url: string, options: HealthOptions = {}): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_HEALTH_ATTEMPTS);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  const target = `${url.replace(/\/$/, "")}/health`;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await runtime.fetchFn(target, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore and retry
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts - 1) {
      await runtime.sleepFn(HEALTH_RETRY_DELAY_MS);
    }
  }
  return false;
}

export async function ensureManagedLiveSession(
  store: Store,
  gameId: string,
): Promise<EnsureManagedLiveSessionResult> {
  const url = getManagedLiveUrl(gameId);
  if (await isLiveHealthy(url)) {
    return { url, started: false };
  }

  const lockPath = lockPathForGame(store, gameId);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let lockHandle: FileHandle | null = null;

  while (!lockHandle && Date.now() < deadline) {
    lockHandle = await tryAcquireLock(lockPath);
    if (lockHandle) {
      break;
    }
    if (await isLiveHealthy(url, { attempts: 1 })) {
      return { url, started: false };
    }
    await runtime.sleepFn(LOCK_RECHECK_MS);
  }

  if (!lockHandle) {
    throw new Error(`Timed out waiting for managed live session lock for ${gameId}.`);
  }

  try {
    if (await isLiveHealthy(url, { attempts: 1 })) {
      return { url, started: false };
    }

    launchManagedProcess(gameId);
    const healthy = await waitForHealthy(url, STARTUP_TIMEOUT_MS);
    if (!healthy) {
      throw new Error(`Managed live session failed to become healthy for ${gameId}.`);
    }

    return { url, started: true };
  } finally {
    await releaseLock(lockPath, lockHandle);
  }
}

export const INTERNALS = {
  DEFAULT_PORTLESS_PROXY_PORT,
  lockPathForGame,
  buildPortlessInvocation,
  setRuntimeForTests(overrides: Partial<RuntimeDeps>): void {
    Object.assign(runtime, overrides);
  },
  resetRuntimeForTests(): void {
    runtime.fetchFn = fetch.bind(globalThis);
    runtime.spawnFn = spawn;
    runtime.sleepFn = (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
  },
};
