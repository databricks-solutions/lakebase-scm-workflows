#!/usr/bin/env node
// CLI: regenerate per-AC views from a feature's master test list.

import { readMasterTestList, writePerAcViews } from "./test-list.js";

function main(): number {
  const [tddDir = ".tdd", featureId] = process.argv.slice(2);
  if (!featureId) {
    process.stderr.write("usage: test-list <tddDir> <featureId>\n");
    return 1;
  }
  const list = readMasterTestList(tddDir, featureId);
  const written = writePerAcViews(tddDir, featureId, list);
  for (const f of written) process.stdout.write(`wrote ${f}\n`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
