#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const REQUIRED_ROOT_FILES = [
  "README.md",
  "docs/README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
];

const REQUIRED_FR_FILES = [
  "docs/fr/index.md",
  "docs/fr/getting-started.md",
  "docs/fr/architecture.md",
  "docs/fr/local-transcription.md",
  "docs/fr/cloud-transcription.md",
  "docs/fr/llm-cloud.md",
  "docs/fr/llm-local.md",
  "docs/fr/settings-reference.md",
  "docs/fr/security-privacy.md",
  "docs/fr/deployment-operations.md",
  "docs/fr/ci-quality-observability.md",
  "docs/fr/troubleshooting.md",
  "docs/fr/contributing.md",
  "docs/fr/glossary.md",
];

const REQUIRED_EN_FILES = [
  "docs/en/index.md",
  "docs/en/getting-started.md",
  "docs/en/architecture.md",
  "docs/en/local-transcription.md",
  "docs/en/cloud-transcription.md",
  "docs/en/llm-cloud.md",
  "docs/en/llm-local.md",
  "docs/en/settings-reference.md",
  "docs/en/security-privacy.md",
  "docs/en/deployment-operations.md",
  "docs/en/ci-quality-observability.md",
  "docs/en/troubleshooting.md",
  "docs/en/contributing.md",
  "docs/en/glossary.md",
];

const SKIP_SCHEMES = new Set(["http", "https", "mailto", "tel", "data"]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertFilePresentAndNonEmpty(relativePath, errors) {
  const absolutePath = path.resolve(ROOT, relativePath);
  if (!(await exists(absolutePath))) {
    errors.push(`Missing required file: ${relativePath}`);
    return;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  if (!content.trim()) {
    errors.push(`Required file is empty: ${relativePath}`);
  }
}

async function listMarkdownFiles(rootRelativeDir) {
  const absoluteRoot = path.resolve(ROOT, rootRelativeDir);
  const result = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absoluteEntry = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absoluteEntry);
        continue;
      }
      if (entry.isFile() && absoluteEntry.toLowerCase().endsWith(".md")) {
        result.push(path.relative(ROOT, absoluteEntry).split(path.sep).join("/"));
      }
    }
  }

  if (await exists(absoluteRoot)) {
    await walk(absoluteRoot);
  }

  return result.sort();
}

function headingToSlug(rawHeading) {
  const cleaned = rawHeading
    .trim()
    .replace(/`/g, "")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_{|}~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return cleaned;
}

function extractAnchors(markdownContent) {
  const anchors = new Set();
  const duplicateCounter = new Map();
  const lines = markdownContent.split(/\r?\n/);

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!headingMatch) continue;

    const base = headingToSlug(headingMatch[1] ?? "");
    if (!base) continue;

    const seen = duplicateCounter.get(base) ?? 0;
    duplicateCounter.set(base, seen + 1);
    const finalSlug = seen === 0 ? base : `${base}-${seen}`;
    anchors.add(finalSlug);
  }

  return anchors;
}

function parseMarkdownLinks(markdownContent) {
  const links = [];
  const regex = /(!)?\[[^\]]*\]\(([^)]+)\)/g;
  let match;

  while ((match = regex.exec(markdownContent)) !== null) {
    const isImage = Boolean(match[1]);
    if (isImage) continue;

    const rawTarget = (match[2] ?? "").trim();
    if (!rawTarget) continue;

    const line = markdownContent.slice(0, match.index).split(/\r?\n/).length;
    links.push({ rawTarget, line });
  }

  return links;
}

function normalizeLinkTarget(rawTarget) {
  const trimmed = rawTarget.trim();

  // Strip optional title segment: path "title"
  const firstToken = trimmed.match(/^<([^>]+)>/)?.[1] ?? trimmed.split(/\s+/)[0] ?? "";
  return firstToken.trim();
}

function splitPathAndAnchor(target) {
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) {
    return { targetPath: target, anchor: "" };
  }
  return {
    targetPath: target.slice(0, hashIndex),
    anchor: target.slice(hashIndex + 1),
  };
}

function hasSkippableScheme(target) {
  if (target.startsWith("//")) return true;
  const schemeMatch = target.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return false;
  return SKIP_SCHEMES.has(schemeMatch[1].toLowerCase()) || schemeMatch[1].length > 0;
}

async function resolveRelativeTarget(sourceFile, targetPath) {
  const sourceDir = path.dirname(path.resolve(ROOT, sourceFile));
  const absoluteTarget = path.resolve(sourceDir, targetPath);

  const candidates = [absoluteTarget];
  if (!path.extname(absoluteTarget)) {
    candidates.push(`${absoluteTarget}.md`);
    candidates.push(path.join(absoluteTarget, "README.md"));
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function readFileCached(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  const content = await fs.readFile(filePath, "utf8");
  cache.set(filePath, content);
  return content;
}

async function validateLinks(markdownFiles, errors) {
  const contentCache = new Map();
  const anchorCache = new Map();

  async function getAnchors(absolutePath) {
    if (anchorCache.has(absolutePath)) return anchorCache.get(absolutePath);
    const content = await readFileCached(absolutePath, contentCache);
    const anchors = extractAnchors(content);
    anchorCache.set(absolutePath, anchors);
    return anchors;
  }

  for (const relativeFile of markdownFiles) {
    const absoluteFile = path.resolve(ROOT, relativeFile);
    const content = await readFileCached(absoluteFile, contentCache);
    const links = parseMarkdownLinks(content);

    for (const { rawTarget, line } of links) {
      const normalizedTarget = normalizeLinkTarget(rawTarget);
      if (!normalizedTarget) continue;
      if (hasSkippableScheme(normalizedTarget)) continue;

      if (normalizedTarget.startsWith("#")) {
        const localAnchor = normalizedTarget.slice(1).trim().toLowerCase();
        if (!localAnchor) continue;

        const anchors = await getAnchors(absoluteFile);
        if (!anchors.has(localAnchor)) {
          errors.push(`${relativeFile}:${line} -> missing local anchor #${localAnchor}`);
        }
        continue;
      }

      const { targetPath, anchor } = splitPathAndAnchor(normalizedTarget);
      const resolvedPath = await resolveRelativeTarget(relativeFile, targetPath || ".");

      if (!resolvedPath) {
        errors.push(`${relativeFile}:${line} -> broken relative link: ${normalizedTarget}`);
        continue;
      }

      if (anchor) {
        const anchors = await getAnchors(resolvedPath);
        const normalizedAnchor = decodeURIComponent(anchor).trim().toLowerCase();
        if (normalizedAnchor && !anchors.has(normalizedAnchor)) {
          const targetRelative = path.relative(ROOT, resolvedPath).split(path.sep).join("/");
          errors.push(
            `${relativeFile}:${line} -> missing anchor #${normalizedAnchor} in ${targetRelative}`
          );
        }
      }
    }
  }
}

async function validateFrEnParity(errors) {
  const frFiles = await listMarkdownFiles("docs/fr");
  const enFiles = await listMarkdownFiles("docs/en");

  const frRelative = new Set(frFiles.map((file) => file.replace(/^docs\/fr\//, "")));
  const enRelative = new Set(enFiles.map((file) => file.replace(/^docs\/en\//, "")));

  for (const file of frRelative) {
    if (!enRelative.has(file)) {
      errors.push(`FR/EN parity mismatch: missing docs/en/${file}`);
    }
  }

  for (const file of enRelative) {
    if (!frRelative.has(file)) {
      errors.push(`FR/EN parity mismatch: missing docs/fr/${file}`);
    }
  }
}

async function main() {
  const errors = [];

  for (const relativePath of REQUIRED_ROOT_FILES) {
    await assertFilePresentAndNonEmpty(relativePath, errors);
  }

  for (const relativePath of REQUIRED_FR_FILES) {
    await assertFilePresentAndNonEmpty(relativePath, errors);
  }

  for (const relativePath of REQUIRED_EN_FILES) {
    await assertFilePresentAndNonEmpty(relativePath, errors);
  }

  await validateFrEnParity(errors);

  const markdownFiles = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ...(await listMarkdownFiles("docs")),
  ];

  await validateLinks(markdownFiles, errors);

  if (errors.length > 0) {
    console.error("[docs:check] FAIL");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("[docs:check] PASS");
}

await main();
