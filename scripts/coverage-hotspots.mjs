#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const lcovPath = path.resolve("coverage/lcov.info");
const outputPath = path.resolve("coverage/hotspots.txt");
const TOP_N = 20;

if (!fs.existsSync(lcovPath)) {
  console.error(`[coverage-hotspots] missing ${lcovPath}`);
  process.exit(1);
}

const content = fs.readFileSync(lcovPath, "utf8");
const lines = content.split(/\r?\n/);

const entries = [];
let file = "";
let lf = 0;
let lh = 0;

for (const line of lines) {
  if (line.startsWith("SF:")) {
    file = line.slice(3);
    lf = 0;
    lh = 0;
    continue;
  }
  if (line.startsWith("LF:")) {
    lf = Number(line.slice(3)) || 0;
    continue;
  }
  if (line.startsWith("LH:")) {
    lh = Number(line.slice(3)) || 0;
    continue;
  }
  if (line === "end_of_record") {
    if (file && lf > 0) {
      const uncovered = Math.max(0, lf - lh);
      const pct = (lh / lf) * 100;
      entries.push({ file, lf, lh, uncovered, pct });
    }
    file = "";
    lf = 0;
    lh = 0;
  }
}

entries.sort((a, b) => {
  if (b.uncovered !== a.uncovered) return b.uncovered - a.uncovered;
  return a.pct - b.pct;
});

const top = entries.slice(0, TOP_N);
const totalLf = entries.reduce((acc, entry) => acc + entry.lf, 0);
const totalLh = entries.reduce((acc, entry) => acc + entry.lh, 0);
const totalPct = totalLf > 0 ? (totalLh / totalLf) * 100 : 0;

const reportLines = [
  "Coverage hotspots (top 20 files by uncovered lines)",
  `Global coverage: ${totalPct.toFixed(2)}% (${totalLh}/${totalLf})`,
  "",
  "Uncovered | Coverage | Covered/Total | File",
  "--------- | -------- | ------------- | ----",
  ...top.map((entry) => {
    const covered = `${entry.lh}/${entry.lf}`;
    return `${String(entry.uncovered).padStart(9)} | ${entry.pct.toFixed(2).padStart(7)}% | ${covered.padStart(
      13
    )} | ${entry.file}`;
  }),
  "",
];

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, reportLines.join("\n"), "utf8");
console.log(`[coverage-hotspots] wrote ${outputPath}`);

