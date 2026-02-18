import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_THRESHOLD = 80;

function parseArgNumber(name, fallback) {
  const token = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!token) return fallback;
  const parsed = Number(token.slice(name.length + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLcovLineCoverage(content) {
  let totalFound = 0;
  let totalHit = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("LF:")) {
      totalFound += Number(line.slice(3)) || 0;
      continue;
    }
    if (line.startsWith("LH:")) {
      totalHit += Number(line.slice(3)) || 0;
    }
  }

  return {
    totalFound,
    totalHit,
    percent: totalFound > 0 ? (totalHit / totalFound) * 100 : 0,
  };
}

async function main() {
  const threshold = parseArgNumber("--min", DEFAULT_THRESHOLD);
  const lcovPath = path.resolve(process.cwd(), "coverage/lcov.info");

  const lcov = await fs.readFile(lcovPath, "utf8");
  const { totalFound, totalHit, percent } = parseLcovLineCoverage(lcov);

  if (totalFound === 0) {
    console.error(`[coverage:project] No line data found in ${lcovPath}`);
    process.exit(1);
  }

  const summary = `[coverage:project] lines ${percent.toFixed(2)}% (${totalHit}/${totalFound}), minimum ${threshold.toFixed(2)}%`;

  if (percent < threshold) {
    console.error(`${summary} -> FAIL`);
    process.exit(1);
  }

  console.log(`${summary} -> PASS`);
}

main().catch((error) => {
  console.error("[coverage:project] failed to read coverage report", error);
  process.exit(1);
});
