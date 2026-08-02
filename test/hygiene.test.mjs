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
  const dir = mkdtempSync(join(tmpdir(), 'mcp-hygiene-'));
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

function scan(dir, denylist = join(dir, 'no-such-denylist')) {
  const r = spawnSync(process.execPath, [SCAN], {
    cwd: dir, encoding: 'utf8',
    // A denylist path that cannot exist unless a test asks for one: the scan
    // must not read the developer's real list, and no test may depend on
    // whether they keep one.
    env: { ...GIT_ENV, HYGIENE_DENYLIST: denylist },
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

  test('a path whose bytes are not valid UTF-8 is still scanned', () => {
    // Reading the list NUL-separated stopped git escaping the name, but not the
    // decoding: execFileSync reads git's raw bytes as UTF-8, so a Latin-1 file
    // name out of a repository written on Linux still arrived with a
    // replacement character in it, and every read then went looking for a name
    // no file has ever had. Both throws were swallowed, the file was skipped
    // without a word, and the summary counted it among the clean ones while an
    // access key sat staged inside it.
    const dir = repo({ 'readme.md': 'nothing of interest here\n' });
    const git = gitIn(dir);
    writeFileSync(join(dir, 'loose'), `key = ${AWS_KEY}\n`);
    const sha = git('hash-object', '-w', join(dir, 'loose')).stdout.trim();
    // Staged directly, because macOS will not create the file: APFS rejects a
    // name that is not valid UTF-8 with EILSEQ. The index takes it regardless,
    // and the index is what gets committed and pushed.
    git('rm', '-q', '--cached', 'loose');
    const entry = Buffer.concat([
      Buffer.from(`100644 ${sha} 0\t`, 'latin1'),
      Buffer.from([0x62, 0xfc, 0x63, 0x68, 0x65, 0x72, 0x2e, 0x74, 0x78, 0x74]),  // b<0xfc>cher.txt
      Buffer.from([0]),
    ]);
    spawnSync('git', ['update-index', '-z', '--index-info'], { cwd: dir, env: GIT_ENV, input: entry });

    const { code, out } = scan(dir);
    assert.equal(code, 1, `a byte git cannot spell hid a credential from the scan:\n${out}`);
    assert.match(out, /AWS access key/);
  });

  test('a finding names the line of the copy it is in', () => {
    // Both copies used to be glued together and scanned as one string, so the
    // line number was counted through the join: a key on line 4 of a four-line
    // working copy was announced at line 45, which reads like a scanner that
    // has lost its place and gets waved through as a false positive.
    const dir = repo({ 'notes.txt': `${Array.from({ length: 40 }, (_, i) => `line ${i + 1} clean`).join('\n')}\n` });
    writeFileSync(join(dir, 'notes.txt'), `one\ntwo\nthree\nkey = ${AWS_KEY}\n`);
    const { code, out } = scan(dir);
    assert.equal(code, 1, out);
    assert.match(out, /notes\.txt[^:\n]*:4: AWS access key/, `pointed at a line the file does not reach:\n${out}`);
  });

  test('an address belonging to somebody is a finding, an SSH remote is not', () => {
    // This is the rule that cannot be written down as a list, so it works the
    // other way round: everything that is not one of the reserved example
    // domains counts. `git@github.com:owner/repo` is a remote rather than a
    // person, and reporting it would teach the reader to wave the whole check
    // through.
    // Assembled, never written down — for the same reason AWS_KEY is. Spelled
    // out here, this file would be a tracked file with somebody's address in
    // it, and the scan would be quite right to fail on it.
    const LOCAL = 'a.person', DOMAIN = 'some-provider' + '.ch';
    const dir = repo({
      'remote.txt': 'git' + '@github.com:someone/somewhere.git\n',
      'notes.txt': `reply came back from ${LOCAL}@${DOMAIN} instead\n`,
    });
    const { code, out } = scan(dir);
    assert.equal(code, 1, out);
    assert.ok(out.includes(`email address at @${DOMAIN}`), `the domain is what says where to look:\n${out}`);
    // Same rule as for a secret: the finding says where to look, not what it is.
    assert.ok(!out.includes(LOCAL), `the address was echoed into the report:\n${out}`);
    assert.ok(!/github\.com/.test(out), `an SSH remote was read as somebody's address:\n${out}`);
  });

  test('an allowed domain worn as a suffix is not an allowed address', () => {
    // In a file this is caught for a reason worth pinning down: what finds an
    // address stops at the second @, so what the rule is handed is the real
    // address alone and the permitted tail never reaches it. Widen that finder
    // one day and the suffix becomes the bypass it is on the identity path,
    // where the raw value goes straight to the rule — see the test below.
    // Assembled rather than written down, for the reason the test above gives.
    const LOCAL = 'a.person', DOMAIN = 'some-provider' + '.ch';
    const { code, out } = scan(repo({ 'notes.txt': `reply came back from ${LOCAL}@${DOMAIN}@example.com instead\n` }));
    assert.equal(code, 1, `an allowed domain as a suffix was accepted:\n${out}`);
    assert.ok(out.includes(`email address at @${DOMAIN}`), `named the wrong domain:\n${out}`);
  });

  test('a committer identity that is not a hostname is not an allowed identity', () => {
    // Only reachable here. The file scan never sees these, because what finds
    // an address in a file will not accept a space or a slash inside a domain
    // and so does not offer them up at all. The identity check has no such
    // filter: it hands over whatever git recorded — and the check used to read
    // only the tail of it, so an address with a permitted domain appended after
    // a second @ was an allowed identity, while the subdomain part took any
    // characters whatsoever in front of a permitted domain.
    const LOCAL = 'a.person', DOMAIN = 'some-provider' + '.ch';
    for (const bad of [
      `${LOCAL}@${DOMAIN}@example.com`,     // a real address wearing an allowed one
      `${LOCAL}@evil host.example.com`,     // a space is not a hostname label
      `${LOCAL}@x/y.example.com`,           // and neither is a slash
    ]) {
      const dir = repo({ 'notes.txt': 'nothing of interest\n' });
      const git = gitIn(dir);
      git('config', 'user.email', bad);
      git('commit', '-q', '--allow-empty', '-m', 'second');
      const { code, out } = scan(dir);
      assert.equal(code, 1, `${bad} was accepted as an identity:\n${out}`);
      assert.match(out, /commit identity is not anonymous/, out);
    }
  });

  test('a real subdomain of a permitted domain is still permitted', () => {
    // The other half: tightening the rule must not start failing the ordinary
    // case, or the next person loosens it back to where it started.
    const { code, out } = scan(repo({ 'notes.txt': 'wrote to a.person@deep.sub.example.org and heard nothing\n' }));
    assert.equal(code, 0, out);
  });

  test('a denylisted name is caught in either normalisation', () => {
    // The terms that identify the author cannot live in this repository, so the
    // list is read from outside it. The names that leaked the first time came
    // out of the service in NFD — a umlaut written as a plus a combining
    // diaeresis — and a byte-exact search walked straight past them.
    const list = join(mkdtempSync(join(tmpdir(), 'mcp-denylist-')), 'denylist.txt');
    writeFileSync(list, '# a comment, and a blank line follow\n\nSchnürkli\n');
    // Written out decomposed on purpose, and not by hand: an editor would
    // normalise it back the moment the file was saved.
    const decomposed = 'Schn' + '\u0075\u0308' + 'rkli';
    assert.equal(decomposed.length, 10, 'the fixture is meant to be NFD');
    const dir = repo({ 'notes.txt': `Absender: ${decomposed} AG\n` });
    const { code, out } = scan(dir, list);
    assert.equal(code, 1, `NFD walked past the list:\n${out}`);
    assert.match(out, /denylisted term \(9 chars\)/);
    assert.ok(!out.includes('chn'), `the term was echoed into the report:\n${out}`);
  });

  test('a tracked path that yields no readable copy at all is a failure', () => {
    // Every miss this scan has had took the same shape: a path it could not
    // open, both reads throwing, both throws swallowed, and the summary going
    // on to call the repository clean. Whatever the reason turns out to be next
    // time, not having scanned something is not the same as having found
    // nothing in it.
    const dir = repo({ 'readme.md': 'nothing of interest here\n' });
    const git = gitIn(dir);
    // An index entry pointing at an object that is not in the repository, and
    // nothing of that name on disk either — the state a partial clone or a
    // pruned object store leaves behind.
    const missing = 'e'.repeat(40);
    git('update-index', '--add', '--cacheinfo', `100644,${missing},ghost.txt`);
    const { code, out } = scan(dir);
    assert.equal(code, 1, `it was skipped in silence:\n${out}`);
    assert.match(out, /ghost\.txt: tracked, but no copy of it could be read/);
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
