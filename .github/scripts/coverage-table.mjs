#!/usr/bin/env node
// Build a per-package coverage markdown table from vitest's
// `coverage-summary.json` output, and emit it as a GitHub Actions
// step output named `markdown` so the surrounding workflow can
// hand it to the sticky-comment action.
//
// Why a custom script: vitest's `json-summary` reporter writes
// per-FILE entries plus a "total" entry. Per-PACKAGE rollups (the
// reviewable unit at PR-review time) are not in the file —
// have to compute them by grouping file paths under their
// `packages/<name>/` parent. A 60-line script keeps the rollup
// transparent and avoids a third-party action just for table
// formatting.

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------

const summaryPath = resolve("coverage", "coverage-summary.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));

// Group file-level metrics by package (`packages/<name>/...`).
const buckets = new Map();
for (const [filePath, metrics] of Object.entries(summary)) {
  if (filePath === "total") continue;
  const match = filePath.match(/[\\/]packages[\\/]([^\\/]+)[\\/]/);
  if (!match) continue;
  const pkg = match[1];
  if (!buckets.has(pkg)) buckets.set(pkg, []);
  buckets.get(pkg).push(metrics);
}

// Aggregate per package as covered/total (NOT averaging file
// percentages — averaging biases toward small files).
const rows = [];
for (const [pkg, fileMetrics] of [...buckets].sort()) {
  const aggregate = (key) => {
    const total = fileMetrics.reduce((sum, m) => sum + (m[key]?.total ?? 0), 0);
    const covered = fileMetrics.reduce((sum, m) => sum + (m[key]?.covered ?? 0), 0);
    return total === 0 ? 100 : (covered / total) * 100;
  };
  rows.push({
    pkg,
    lines: aggregate("lines"),
    functions: aggregate("functions"),
    branches: aggregate("branches"),
    statements: aggregate("statements"),
  });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

let markdown = "## Coverage report\n\n";
markdown += "| Package | Lines | Functions | Branches | Statements |\n";
markdown += "|---|---:|---:|---:|---:|\n";
for (const row of rows) {
  const fmt = (n) => `${n.toFixed(1)}%`;
  markdown += `| \`@funclaw/${row.pkg}\` | ${fmt(row.lines)} | ${fmt(row.functions)} | ${fmt(row.branches)} | ${fmt(row.statements)} |\n`;
}

// Repository-wide total (from the "total" entry in the summary).
const total = summary.total;
if (total) {
  const fmt = (m) => `${m.pct.toFixed(1)}%`;
  markdown += `| **Total** | **${fmt(total.lines)}** | **${fmt(total.functions)}** | **${fmt(total.branches)}** | **${fmt(total.statements)}** |\n`;
}

markdown += "\n_v1 thresholds enforced by `vitest.config.ts` "
  + "(75% core / 20% adapter floor)._\n";

// ---------------------------------------------------------------------------
// Emit to $GITHUB_OUTPUT (multiline value via heredoc-style delimiter).
// ---------------------------------------------------------------------------

const output = process.env.GITHUB_OUTPUT;
if (!output) {
  // Local invocation: just print the markdown.
  console.log(markdown);
  process.exit(0);
}

const delimiter = `MD_EOF_${Math.random().toString(36).slice(2, 10)}`;
appendFileSync(output, `markdown<<${delimiter}\n${markdown}\n${delimiter}\n`);
