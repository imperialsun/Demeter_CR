/* @vitest-environment node */
import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { auditObservability } from "./observability-audit.mjs";

const tempDirs: string[] = [];

async function createFixture(files: Record<string, string>) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "observability-audit-"));
  tempDirs.push(rootDir);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return rootDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("observability-audit script", () => {
  it("passes when console usage is compliant and mandatory LLM markers exist", async () => {
    const rootDir = await createFixture({
      "src/lib/logger.ts": "export const x = () => { console.info('ok'); };",
      "src/hooks/useLlmReports.ts": `
        const logger = { info: () => undefined };
        const telemetry = { logEvent: () => undefined };
        export async function run() {
          logger.info('[llm] start');
          telemetry.logEvent('LLM_RUN_START');
          telemetry.logEvent('LLM_RUN_DONE');
          telemetry.logEvent('LLM_RUN_ERROR');
          await Promise.resolve();
        }
      `,
      "src/routes/LocalUploadPage.tsx": `
        const logger = { info: () => undefined };
        export async function load() {
          logger.info('[localupload] loading');
          await Promise.resolve();
        }
      `,
    });

    const result = await auditObservability({ rootDir });
    expect(result.ok).toBe(true);
    expect(result.consoleViolations).toHaveLength(0);
    expect(result.asyncWithoutLogger).toHaveLength(0);
    expect(result.missingLlmMarkers).toHaveLength(0);
  });

  it("fails when console.* is used outside the allowlist", async () => {
    const rootDir = await createFixture({
      "src/lib/logger.ts": "export const x = () => { console.info('ok'); };",
      "src/lib/bad.ts": "export const bad = () => { console.warn('forbidden'); };",
      "src/hooks/useLlmReports.ts": `
        const logger = { info: () => undefined };
        const telemetry = { logEvent: () => undefined };
        export function run() {
          logger.info('[llm] start');
          telemetry.logEvent('LLM_RUN_START');
          telemetry.logEvent('LLM_RUN_DONE');
          telemetry.logEvent('LLM_RUN_ERROR');
        }
      `,
    });

    const result = await auditObservability({ rootDir });
    expect(result.ok).toBe(false);
    expect(result.consoleViolations.some((entry) => entry.path === "src/lib/bad.ts")).toBe(true);
  });

  it("fails when async/network logic has no structured logger", async () => {
    const rootDir = await createFixture({
      "src/lib/logger.ts": "export const x = () => { console.info('ok'); };",
      "src/hooks/useLlmReports.ts": `
        const logger = { info: () => undefined };
        const telemetry = { logEvent: () => undefined };
        export function run() {
          logger.info('[llm] start');
          telemetry.logEvent('LLM_RUN_START');
          telemetry.logEvent('LLM_RUN_DONE');
          telemetry.logEvent('LLM_RUN_ERROR');
        }
      `,
      "src/routes/CloudUploadPage.tsx": `
        export async function load() {
          const response = await fetch('https://example.test');
          return response.ok;
        }
      `,
    });

    const result = await auditObservability({ rootDir });
    expect(result.ok).toBe(false);
    expect(result.asyncWithoutLogger).toContain("src/routes/CloudUploadPage.tsx");
  });

  it("fails when mandatory LLM markers are missing", async () => {
    const rootDir = await createFixture({
      "src/lib/logger.ts": "export const x = () => { console.info('ok'); };",
      "src/hooks/useLlmReports.ts": `
        const logger = { info: () => undefined };
        const telemetry = { logEvent: () => undefined };
        export function run() {
          logger.info('[llm] start');
          telemetry.logEvent('LLM_RUN_START');
        }
      `,
    });

    const result = await auditObservability({ rootDir });
    expect(result.ok).toBe(false);
    expect(result.missingLlmMarkers).toContain("LLM_RUN_DONE");
    expect(result.missingLlmMarkers).toContain("LLM_RUN_ERROR");
  });
});
