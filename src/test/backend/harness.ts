import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";

const BOOTSTRAP_ADMIN_EMAIL = "admin@demeter.local";
const BOOTSTRAP_ADMIN_PASSWORD = "ChangeMe123!";
const BOOTSTRAP_ORG_NAME = "Demeter Integration";
const BACKEND_READY_PATH = "/healthz";
const HEALTH_CHECK_TIMEOUT_MS = 20_000;
const HEALTH_CHECK_INTERVAL_MS = 250;
const LOG_BUFFER_LIMIT = 200;

type HarnessState = {
  backendDir: string;
  baseUrl: string;
  sqliteDir: string;
  process: ChildProcess;
  stdoutLog: string[];
  stderrLog: string[];
  stopPromise?: Promise<void>;
};

declare global {
  var __demeterBackendHarnessPromise: Promise<HarnessState> | undefined;
}

export async function ensureBackendHarness(): Promise<HarnessState> {
  globalThis.__demeterBackendHarnessPromise ??= startBackendHarness();
  return globalThis.__demeterBackendHarnessPromise;
}

export async function stopBackendHarness(): Promise<void> {
  const promise = globalThis.__demeterBackendHarnessPromise;
  if (!promise) return;

  const state = await promise;
  if (!state.stopPromise) {
    state.stopPromise = (async () => {
      if (state.process.exitCode === null && !state.process.killed) {
        state.process.kill("SIGTERM");
        await waitForProcessExit(state.process, 5_000).catch(() => {
          state.process.kill("SIGKILL");
        });
      }
      await rm(state.sqliteDir, { recursive: true, force: true });
    })().finally(() => {
      globalThis.__demeterBackendHarnessPromise = undefined;
    });
  }

  await state.stopPromise;
}

export function getBootstrapAdminCredentials() {
  return {
    email: BOOTSTRAP_ADMIN_EMAIL,
    password: BOOTSTRAP_ADMIN_PASSWORD,
  };
}

async function startBackendHarness(): Promise<HarnessState> {
  const backendDir = path.resolve(process.cwd(), "../Backend");
  await assertBackendPrerequisites(backendDir);

  const port = await getAvailablePort();
  const sqliteDir = await mkdtemp(path.join(os.tmpdir(), "demeter-backend-integration-"));
  const sqlitePath = path.join(sqliteDir, "backend.sqlite");

  const stdoutLog: string[] = [];
  const stderrLog: string[] = [];
  const child = spawn("go", ["run", "./cmd/server"], {
    cwd: backendDir,
    env: {
      ...process.env,
      APP_ENV: "development",
      PORT: String(port),
      SQLITE_PATH: sqlitePath,
      JWT_SECRET: "demeter-integration-secret",
      COOKIE_SECURE: "false",
      APP_CORS_ORIGINS: "http://localhost:3000,http://localhost:4173",
      BOOTSTRAP_ADMIN_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD,
      BOOTSTRAP_ORG_NAME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendLog(stdoutLog, chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => appendLog(stderrLog, chunk));

  const state: HarnessState = {
    backendDir,
    baseUrl: `http://127.0.0.1:${port}`,
    sqliteDir,
    process: child,
    stdoutLog,
    stderrLog,
  };

  const teardown = () => {
    void stopBackendHarness();
  };
  process.once("exit", teardown);
  process.once("SIGINT", teardown);
  process.once("SIGTERM", teardown);

  try {
    await waitForHealth(state);
    return state;
  } catch (error) {
    await stopBackendHarness().catch(() => undefined);
    const details = formatHarnessLogs(state);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${details}`);
  }
}

async function assertBackendPrerequisites(backendDir: string) {
  await access(path.join(backendDir, "cmd/server/main.go")).catch(() => {
    throw new Error(`Backend checkout not found at ${backendDir}. Expected ../Backend with cmd/server/main.go.`);
  });

  await new Promise<void>((resolve, reject) => {
    const probe = spawn("go", ["version"], {
      stdio: "ignore",
    });
    probe.once("error", () => reject(new Error("go is not installed or not available in PATH.")));
    probe.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`go version failed with exit code ${code}.`));
    });
  });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve an available port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.once("error", reject);
  });
}

async function waitForHealth(state: HarnessState) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_CHECK_TIMEOUT_MS) {
    if (state.process.exitCode !== null) {
      throw new Error(`Backend process exited early with code ${state.process.exitCode}.`);
    }

    try {
      if (await probeHealth(`${state.baseUrl}${BACKEND_READY_PATH}`)) {
        return;
      }
    } catch {
      // Retry until the backend is ready.
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for backend health at ${state.baseUrl}${BACKEND_READY_PATH}.`);
}

function probeHealth(url: string) {
  return new Promise<boolean>((resolve) => {
    const request = http.get(url, { timeout: 400 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });

    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function appendLog(buffer: string[], chunk: string) {
  const trimmed = chunk.trim();
  if (!trimmed) return;
  buffer.push(trimmed);
  if (buffer.length > LOG_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - LOG_BUFFER_LIMIT);
  }
}

function formatHarnessLogs(state: HarnessState) {
  const stdout = state.stdoutLog.slice(-20).join("\n") || "<empty>";
  const stderr = state.stderrLog.slice(-20).join("\n") || "<empty>";
  return [`Backend logs for ${state.baseUrl}:`, "[stdout]", stdout, "[stderr]", stderr].join("\n");
}

function waitForProcessExit(processToWait: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (processToWait.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for backend process exit."));
    }, timeoutMs);

    processToWait.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
