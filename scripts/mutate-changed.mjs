#!/usr/bin/env node
// Mutation-test only the lines a change touched.
//
// A full pass over index.js is affordable here and is not affordable in the two
// sibling servers, whose suites drive a real browser: at their pace the same
// 832 mutants come to most of a working day. But a review round does not need
// the whole file re-proved — it needs the lines it just wrote proved, and those
// are exactly what git already knows.
//
//   node scripts/mutate-changed.mjs             # against origin/main
//   node scripts/mutate-changed.mjs HEAD~3      # against anything else
//   node scripts/mutate-changed.mjs HEAD~3 --list   # say what it would do
//
// Nothing changed means nothing to mutate, and that is reported and exited 0
// rather than quietly turned into a full run — a whole-file pass started by
// accident is the one outcome this script exists to avoid.
import { execFileSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2).filter(a => a !== '--list');
const listOnly = process.argv.includes('--list');
const base = argv[0] || 'origin/main';
const FILE = 'index.js';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

let diff;
try {
  diff = git('diff', '-U0', `${base}...HEAD`, '--', FILE);
} catch {
  // No such base, or no upstream. Fall back to the previous commit, which is
  // the useful default when the branch has not been pushed yet.
  diff = git('diff', '-U0', 'HEAD~1', '--', FILE);
}

// @@ -old,len +new,len @@ — only the new side matters, and a hunk with no
// length is one line. Context is zero, so every hunk is a real change.
const ranges = [];
for (const [, start, len] of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
  const from = Number(start);
  const count = len === undefined ? 1 : Number(len);
  if (count === 0) continue;             // a pure deletion leaves nothing to mutate
  ranges.push([from, from + count - 1]);
}

if (!ranges.length) {
  console.log(`No changed lines in ${FILE} against ${base} — nothing to mutate.`);
  process.exit(0);
}

// Merge what touches or overlaps, so two hunks a line apart are one argument.
ranges.sort((a, b) => a[0] - b[0]);
const merged = [ranges[0]];
for (const [from, to] of ranges.slice(1)) {
  const last = merged.at(-1);
  if (from <= last[1] + 1) last[1] = Math.max(last[1], to);
  else merged.push([from, to]);
}

const args = ['stryker', 'run', ...merged.flatMap(([a, b]) => ['--mutate', `${FILE}:${a}-${b}`])];
const lines = merged.reduce((n, [a, b]) => n + (b - a + 1), 0);
console.log(`${merged.length} range(s), ${lines} line(s) against ${base}:`);
for (const [a, b] of merged) console.log(`  ${FILE}:${a}-${b}`);

if (listOnly) process.exit(0);

const r = spawnSync('npx', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
