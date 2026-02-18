import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const DIST_DIR = path.resolve(process.cwd(), "dist");
const MANIFEST_PATH = path.join(DIST_DIR, ".vite", "manifest.json");
const SHOULD_OBFUSCATE = (process.env.VITE_OBFUSCATE ?? "1") !== "0";

const EXCLUDED_FILE_PATTERNS = [
  /^assets\/transformers\.web-.*\.js$/i,
  /^assets\/worker-.*\.js$/i,
  /^assets\/__vite-browser-external-.*\.js$/i,
  /^assets\/vendor-.*\.js$/i,
  /^ffmpeg\//i,
  /^onnx\//i,
  /^worklets\//i,
  /\.wasm$/i,
];

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function isObfuscableAsset(relativePath) {
  if (!relativePath.toLowerCase().endsWith(".js")) return false;
  return !EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectTargetsFromManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  const queue = Object.keys(manifest).filter((key) => {
    const entry = manifest[key];
    return typeof entry?.src === "string" && entry.src.startsWith("src/");
  });

  const visited = new Set();
  const files = new Set();

  while (queue.length > 0) {
    const key = queue.pop();
    if (!key || visited.has(key)) continue;
    visited.add(key);

    const entry = manifest[key];
    if (!entry) continue;

    if (typeof entry.file === "string") {
      files.add(normalizeRelativePath(entry.file));
    }

    const links = [
      ...(Array.isArray(entry.imports) ? entry.imports : []),
      ...(Array.isArray(entry.dynamicImports) ? entry.dynamicImports : []),
    ];
    for (const linkedKey of links) {
      if (typeof linkedKey === "string" && manifest[linkedKey]) {
        queue.push(linkedKey);
      }
    }
  }

  return [...files].filter(isObfuscableAsset).sort();
}

async function collectTargetsByScanningDist() {
  const assetsDir = path.join(DIST_DIR, "assets");
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizeRelativePath(path.posix.join("assets", entry.name)))
    .filter(isObfuscableAsset)
    .sort();
}

async function loadJavascriptObfuscatorStrict() {
  const module = await import("javascript-obfuscator");
  const resolved = module?.default ?? module;
  if (!resolved || typeof resolved.obfuscate !== "function") {
    throw new Error(
      "javascript-obfuscator is installed but invalid. Production obfuscation cannot continue."
    );
  }
  return resolved;
}

async function main() {
  if (!SHOULD_OBFUSCATE) {
    console.log("[obfuscate-dist] skipped (VITE_OBFUSCATE=0)");
    return;
  }

  if (!(await fileExists(DIST_DIR))) {
    throw new Error("dist/ not found. Run build before obfuscation.");
  }

  const hasManifest = await fileExists(MANIFEST_PATH);
  const targets = hasManifest ? await collectTargetsFromManifest() : await collectTargetsByScanningDist();

  if (targets.length === 0) {
    console.log("[obfuscate-dist] no obfuscable target found");
    return;
  }

  const obfuscator = await loadJavascriptObfuscatorStrict();

  let changedCount = 0;
  for (const relativeFile of targets) {
    const absoluteFile = path.join(DIST_DIR, relativeFile);
    const source = await fs.readFile(absoluteFile, "utf8");
    const output = obfuscator
      .obfuscate(source, {
        compact: true,
        sourceMap: false,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        stringArray: true,
        stringArrayThreshold: 0.5,
        identifierNamesGenerator: "hexadecimal",
        disableConsoleOutput: true,
      })
      .getObfuscatedCode();

    if (output !== source) {
      await fs.writeFile(absoluteFile, output, "utf8");
      changedCount += 1;
    }
  }

  console.log(`[obfuscate-dist] processed ${targets.length} file(s), updated ${changedCount}, engine=javascript-obfuscator`);
}

await main();
