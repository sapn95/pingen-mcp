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

// stderr ignored: a bad ref makes git say so in its own words, and then this
// script says so in words that name what to do about it. One is enough.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// A base that cannot be resolved is not a smaller question, it is a different
// one. Falling back quietly meant the line below went on saying "against
// origin/main" while the ranges came from somewhere else entirely — and the
// ranges are the whole output: mutating the wrong ones proves the wrong lines
// and reports a score for them. An explicit base is therefore an error if it
// does not resolve, and only the default is allowed to fall back, out loud.
const explicit = argv.length > 0;
let diff, against = base;
try {
  diff = git('diff', '-U0', `${base}...HEAD`, '--', FILE);
} catch {
  if (explicit) {
    console.error(`Cannot compare ${FILE} against ${base}. Fetch that ref, or pass one that resolves.`);
    process.exit(2);
  }
  // No upstream yet, which is ordinary on a branch that has not been pushed.
  against = 'HEAD~1';
  console.warn(`${base} does not resolve — comparing against ${against} instead.`);
  try {
    diff = git('diff', '-U0', against, '--', FILE);
  } catch {
    console.error(`Neither ${base} nor ${against} resolves. Pass a base explicitly.`);
    process.exit(2);
  }
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
  console.log(`No changed lines in ${FILE} against ${against} — nothing to mutate.`);
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

// One --mutate, comma separated. Repeating the flag does NOT accumulate:
// Stryker parses it with `val => val.split(',')`, which ignores the value
// already there, so commander's last occurrence simply wins. A script that
// passed one flag per range would have mutated only the final hunk while
// printing all of them — the quietest way there is to report a score for
// lines nothing was run against.
const spec = merged.map(([a, b]) => `${FILE}:${a}-${b}`).join(',');
const args = ['stryker', 'run', '--mutate', spec];
const lines = merged.reduce((n, [a, b]) => n + (b - a + 1), 0);
console.log(`${merged.length} range(s), ${lines} line(s) against ${against}:`);
for (const [a, b] of merged) console.log(`  ${FILE}:${a}-${b}`);

if (listOnly) process.exit(0);

const r = spawnSync('npx', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
