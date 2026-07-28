// The hygiene scan is the last thing between a secret and a public push, so it
// gets tests of its own rather than only being run over this repository — where
// everything is clean and a scan that quietly skipped half the files would look
// exactly the same. Each test builds a throwaway git repository and runs the
// real script against it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCAN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hygiene.mjs');

// The developer's own git configuration is kept out of it: a global
// core.quotepath, a signing key or a commit template would each change what the
// scan sees, and the point of these tests is the default a fresh clone gets.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

// Assembled at runtime, never written down. The scan matches the AWS key-id
// shape wherever it finds it — including in this file, which is itself tracked
// and would fail the very check it is testing.
const AWS_KEY = 'AKIA' + 'Q'.repeat(16);

// Failures are tolerated because one fixture below deliberately runs a merge
// that conflicts, and git reports that with a non-zero exit like any other.
const gitIn = dir => (...a) => spawnSync('git', a, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pingen-hygiene-'));
  const git = gitIn(dir);
  git('init', '-q');
  // example.com is one of the addresses the scan accepts as identifying nobody,
  // so the commit-identity check passes and the file rules are what is on trial.
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'fixture');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function scan(dir) {
  const r = spawnSync(process.execPath, [SCAN], {
    cwd: dir, encoding: 'utf8',
    // A denylist path that cannot exist: the scan must not read the developer's
    // real one, and no test may depend on whether they keep one.
    env: { ...GIT_ENV, HYGIENE_DENYLIST: join(dir, 'no-such-denylist') },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the hygiene scan', () => {
  test('passes a repository with nothing to find', () => {
    const { code, out } = scan(repo({ 'readme.md': 'nothing of interest here\n' }));
    assert.equal(code, 0, out);
    assert.match(out, /tracked files clean/);
  });

  test('fails on a committed access key', () => {
    const { code, out } = scan(repo({ 'config.txt': `key = ${AWS_KEY}\n` }));
    assert.equal(code, 1, out);
    assert.match(out, /AWS access key/);
  });

  test('a name git has to quote is still scanned', () => {
    // `git ls-files` escapes anything outside printable ASCII and wraps it in
    // quotes, so the scan was handed "Rechnung-Z\303\274rich.txt" — a string no
    // file has ever been called. Reading it failed, the failure was swallowed
    // as "not staged", and the summary went on to call every tracked file
    // clean while an access key sat in one of them.
    const { code, out } = scan(repo({ 'bücher.txt': `key = ${AWS_KEY}\n` }));
    assert.equal(code, 1, `an umlaut hid a credential from the scan:\n${out}`);
    assert.match(out, /AWS access key/);
  });

  test('a credential file whose name git has to quote is still refused', () => {
    // Same escaping, second victim: the tracked-file rule matches names that
    // end in .env or .env.something, and every quoted name ends in a quote.
    const { code, out } = scan(repo({ '.env.bücher': 'PINGEN_CLIENT_SECRET=hunter2\n' }));
    assert.equal(code, 1, `a tracked .env file slipped through:\n${out}`);
    assert.match(out, /session\/credential file is tracked/);
  });

  test('scans the working tree during an unfinished merge, and quietly', () => {
    // A conflicted path is in the index at stages 1 to 3 and at no stage 0, so
    // `git show :path` refuses it — and execFileSync hands git's "fatal:"
    // straight to the report, which reads like the scanner itself broke. What
    // matters is that the working-tree copy, conflict markers and all, is still
    // read: that copy is what a hurried `git add -A` would commit next.
    const dir = repo({ 'notes.txt': 'base\n' });
    const git = gitIn(dir);
    git('checkout', '-qb', 'other');
    writeFileSync(join(dir, 'notes.txt'), 'from the other branch\n');
    git('commit', '-qam', 'other');
    git('checkout', '-q', '-');
    writeFileSync(join(dir, 'notes.txt'), `key = ${AWS_KEY}\n`);
    git('commit', '-qam', 'main');
    const merge = git('merge', 'other');
    assert.notEqual(merge.status, 0, 'the fixture was supposed to conflict');

    const { code, out } = scan(dir);
    assert.doesNotMatch(out, /fatal:/, `git's complaints reached the report:\n${out}`);
    assert.equal(code, 1, `the conflicted working tree was never scanned:\n${out}`);
    assert.match(out, /AWS access key/);
  });
});
