import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_RUNTIME_ROOTS = ["src/hooks", "src/routes", "src/lib"];
export const DEFAULT_ALLOWED_CONSOLE_FILES = new Set(["src/lib/logger.ts"]);
export const DEFAULT_REQUIRED_LLM_MARKERS = ["LLM_RUN_START", "LLM_RUN_DONE", "LLM_RUN_ERROR"];

const RUNTIME_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ASYNC_OR_NETWORK_REGEX = /\basync\b|\bawait\b|\bfetch\s*\(|new\s+Promise\s*\(/;
const LOGGER_CALL_REGEX = /\blogger\.(info|debug|warn|error)\s*\(/;
const TELEMETRY_REGEX = /\b(logEvent|recordAlert|registerTelemetry|setTelemetrySummary|setTelemetryProvider)\s*\(/;
const CONSOLE_CALL_REGEX = /\bconsole\.(log|info|warn|error|debug)\b/g;

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isRuntimeFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!RUNTIME_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (/\.test\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalized)) return false;
  if (normalized.endsWith("src/setupTests.ts")) return false;
  return true;
}

async function walkFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function getLineNumber(content, index) {
  let lines = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      lines += 1;
    }
  }
  return lines;
}

function findConsoleCalls(content) {
  const matches = [];
  for (const match of content.matchAll(CONSOLE_CALL_REGEX)) {
    const token = match[0] ?? "console";
    const index = match.index ?? 0;
    matches.push({ token, line: getLineNumber(content, index) });
  }
  return matches;
}

export async function collectRuntimeFiles(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimeRoots = options.runtimeRoots ?? DEFAULT_RUNTIME_ROOTS;

  const files = [];
  for (const runtimeRoot of runtimeRoots) {
    const absoluteRoot = path.join(rootDir, runtimeRoot);
    try {
      const stat = await fs.stat(absoluteRoot);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const discovered = await walkFiles(absoluteRoot);
    for (const absolutePath of discovered) {
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (!isRuntimeFile(relativePath)) continue;
      files.push({ absolutePath, relativePath });
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function auditObservability(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const allowedConsoleFiles = options.allowedConsoleFiles ?? DEFAULT_ALLOWED_CONSOLE_FILES;
  const requiredLlmMarkers = options.requiredLlmMarkers ?? DEFAULT_REQUIRED_LLM_MARKERS;

  const runtimeFiles = await collectRuntimeFiles({
    rootDir,
    runtimeRoots: options.runtimeRoots,
  });

  const coverage = [];
  const consoleViolations = [];
  const asyncWithoutLogger = [];
  const markerHits = Object.fromEntries(requiredLlmMarkers.map((marker) => [marker, false]));

  for (const file of runtimeFiles) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    const hasLogger = LOGGER_CALL_REGEX.test(content);
    const hasTelemetry = TELEMETRY_REGEX.test(content);
    const hasAsyncOrNetwork = ASYNC_OR_NETWORK_REGEX.test(content);

    coverage.push({
      path: file.relativePath,
      hasLogger,
      hasTelemetry,
      hasAsyncOrNetwork,
      hasDualCoverage: hasLogger && hasTelemetry,
    });

    if (hasAsyncOrNetwork && !hasLogger) {
      asyncWithoutLogger.push(file.relativePath);
    }

    if (!allowedConsoleFiles.has(file.relativePath)) {
      const consoleCalls = findConsoleCalls(content);
      for (const violation of consoleCalls) {
        consoleViolations.push({
          path: file.relativePath,
          line: violation.line,
          token: violation.token,
        });
      }
    }

    for (const marker of requiredLlmMarkers) {
      if (markerHits[marker]) continue;
      if (content.includes(marker)) {
        markerHits[marker] = true;
      }
    }
  }

  const missingLlmMarkers = requiredLlmMarkers.filter((marker) => !markerHits[marker]);
  const filesWithLogger = coverage.filter((entry) => entry.hasLogger).length;
  const filesWithTelemetry = coverage.filter((entry) => entry.hasTelemetry).length;
  const filesWithDualCoverage = coverage.filter((entry) => entry.hasDualCoverage).length;

  const result = {
    ok: consoleViolations.length === 0 && asyncWithoutLogger.length === 0 && missingLlmMarkers.length === 0,
    scannedFileCount: coverage.length,
    filesWithLogger,
    filesWithTelemetry,
    filesWithDualCoverage,
    dualCoverageRatio: coverage.length ? filesWithDualCoverage / coverage.length : 0,
    coverage,
    consoleViolations,
    asyncWithoutLogger,
    missingLlmMarkers,
  };

  return result;
}

export function formatAuditReport(result) {
  const lines = [];
  lines.push("[observability-audit] Runtime observability report");
  lines.push(`[observability-audit] Files scanned: ${result.scannedFileCount}`);
  lines.push(
    `[observability-audit] Coverage summary -> logger: ${result.filesWithLogger}, telemetry: ${result.filesWithTelemetry}, dual: ${result.filesWithDualCoverage} (${(result.dualCoverageRatio * 100).toFixed(1)}%)`
  );
  lines.push("[observability-audit] Coverage by file:");
  for (const row of result.coverage) {
    lines.push(
      `  - ${row.path} | logger=${row.hasLogger ? "yes" : "no"} | telemetry=${row.hasTelemetry ? "yes" : "no"} | async_or_network=${row.hasAsyncOrNetwork ? "yes" : "no"}`
    );
  }

  if (result.consoleViolations.length > 0) {
    lines.push("[observability-audit] console.* violations (forbidden outside src/lib/logger.ts):");
    for (const violation of result.consoleViolations) {
      lines.push(`  - ${violation.path}:${violation.line} (${violation.token})`);
    }
  }

  if (result.asyncWithoutLogger.length > 0) {
    lines.push("[observability-audit] async/network files without structured logger calls:");
    for (const filePath of result.asyncWithoutLogger) {
      lines.push(`  - ${filePath}`);
    }
  }

  if (result.missingLlmMarkers.length > 0) {
    lines.push("[observability-audit] missing mandatory LLM telemetry markers:");
    for (const marker of result.missingLlmMarkers) {
      lines.push(`  - ${marker}`);
    }
  }

  lines.push(
    result.ok
      ? "[observability-audit] PASS"
      : "[observability-audit] FAIL (fix violations before merging)."
  );

  return lines.join("\n");
}

export async function runAuditFromCwd() {
  const result = await auditObservability();
  const report = formatAuditReport(result);
  if (result.ok) {
    console.log(report);
  } else {
    console.error(report);
  }
  return result.ok ? 0 : 1;
}

const executedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedAsScript) {
  const exitCode = await runAuditFromCwd();
  process.exit(exitCode);
}
