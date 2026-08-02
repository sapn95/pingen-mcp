#!/usr/bin/env node
// Repo hygiene: nothing secret, nothing personal, nothing accidentally staged.
// The personal-data scan exists because an external review caught exactly that
// leaking into documentation that claimed to contain none. It grew teeth after
// a second round: real folder names and a real first name had reached both the
// public history and a published tarball, and every check here was green.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRETS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub PAT'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, 'private key'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'fine-grained GitHub token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/"?access_token"?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/, 'hardcoded access token'],
];

// Addresses that may legitimately appear: the ones that identify nobody. The
// reserved names come from RFC 2606 and RFC 6761 — they cannot resolve, which
// is exactly why fixtures use them.
// noreply@github.com is listed by address rather than by domain on purpose.
// It is the identity the forge puts on the merge commit it builds for a pull
// request, which lands in the CI checkout under --all and is not ours to
// choose — and it is anonymous, which is the only thing this check is about.
// The domain as a whole is not allowed: a real @github.com address is a
// person.
const MAIL_OK = /(^noreply@github\.com$)|@(users\.noreply\.github\.com|anthropic\.com|(.+\.)?(example\.(com|org|net)|invalid|test|localhost))$/;

// Personal detail that has no business in a public repo. Deliberately narrow on
// the German side — these must not fire on ordinary words — and deliberately
// broad on anything that names or reaches a person.
const PERSONAL = [
  [/\bCH\d{2}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d?/, 'looks like an IBAN'],
  [/\b756\.\d{4}\.\d{4}\.\d{2}\b/, 'Swiss social-security number'],
  [/\bBE[ ]?\d{5,6}\b/, 'vehicle plate'],
  [/\+41[ ]?\d{2}[ ]?\d{3}[ ]?\d{2}[ ]?\d{2}|\b07[5-9][ ]?\d{3}[ ]?\d{2}[ ]?\d{2}\b/, 'Swiss phone number'],
  [/\b[A-ZÄÖÜ][a-zäöü]+(strasse|gasse|weg|platz)\s+\d{1,3}\b/, 'street address'],
];

// The lockfile used to be skipped wholesale, and it is exactly where an
// authenticated registry URL ends up. Binary assets are still skipped for the
// text rules — there is nothing to match — but a tracked PDF or screenshot is
// reported, because in these repos there is no reason for one to exist.
//
// -z, because plain `git ls-files` does not print a path — it prints a display
// form of one. Anything outside printable ASCII comes back wrapped in quotes
// with the bytes escaped, so `Rechnung-Zürich.txt` arrived as
// "Rechnung-Z\303\274rich.txt": neither `git show` nor readFileSync could open
// it, both throws were swallowed as "not staged", and the file was skipped
// without a word while the summary still called every tracked file clean. An
// AWS key in a file with an umlaut in its name passed the whole gate. The same
// escaping also stopped the .env and tracked-document rules below from matching,
// because the name they saw ended in a quote. -z writes the real bytes and
// separates them with NUL, so there is nothing to unescape.
//
// -z was only half of it, though, and the half that was left let the very same
// file through again. execFileSync decodes what git wrote as UTF-8, so a path
// whose bytes are not valid UTF-8 — an ordinary Latin-1 file name out of a
// repository written on Linux — still arrives with a replacement character
// where the byte was, and `git show :<that>` and readFileSync(<that>) both go
// looking for a name no file has ever had. So the object id comes along too:
// the staged copy is fetched by content address, with no path in it at all,
// and the working copy is opened with the raw bytes rather than a decoding of
// them. Nothing here has to survive a round trip through a string any more.
function trackedEntries() {
  const raw = execFileSync('git', ['ls-files', '-sz'], { maxBuffer: 64 * 1024 * 1024 });
  const byPath = new Map();
  for (let start = 0; start < raw.length;) {
    let end = raw.indexOf(0, start);
    if (end < 0) end = raw.length;
    const record = raw.subarray(start, end);
    start = end + 1;
    // `<mode> SP <object> SP <stage> TAB <path>` — everything before the tab is
    // ASCII, the path after it is whatever bytes git is holding.
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const [mode, sha, stage] = record.subarray(0, tab).toString('latin1').split(' ');
    const path = record.subarray(tab + 1);
    // latin1 is a byte-for-byte mapping, so it is the honest key for a path and
    // the honest thing to match the ASCII name rules against; the UTF-8 reading
    // is for the report, where a mangled character is only ugly.
    const bytes = path.toString('latin1');
    const entry = byPath.get(bytes) || { path, bytes, name: path.toString('utf8'), mode, sha: null };
    // Only stage 0 is a staged copy. A conflicted path sits at stages 1 to 3
    // and at no stage 0, and there the copy that a hurried `git add -A` would
    // commit next is the one in the working tree — which is read below either
    // way, so a conflict is scanned exactly as it was before.
    if (stage === '0') entry.sha = sha;
    byPath.set(bytes, entry);
  }
  return [...byPath.values()];
}

const tracked = trackedEntries();
const BINARY = /\.(png|jpg|jpeg|gif|pdf|ico|zip|gz)$/i;
const files = tracked.filter(e => !BINARY.test(e.bytes));

// Terms that identify the author cannot be listed here — writing them down in a
// public repo is the very thing this guards against. They live in an untracked
// file instead, one literal per line. CI has no such file and simply skips this;
// the leak starts on the machine that has one, which is where it is checked.
const DENYLIST_PATH = process.env.HYGIENE_DENYLIST || join(homedir(), '.config', 'mcp-hygiene', 'denylist.txt');
const nfc = s => s.normalize('NFC').toLowerCase();
const denylist = existsSync(DENYLIST_PATH)
  ? readFileSync(DENYLIST_PATH, 'utf8').split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#')).map(nfc)
  : null;

let bad = 0;
for (const e of files) {
  // A gitlink is another repository's commit id, not a file here: there is
  // nothing to open and nothing to leak.
  if (e.mode === '160000') continue;
  // BOTH versions, because they are two different exposures. What gets
  // committed is the INDEX — a secret staged and then wiped from the working
  // copy would otherwise sail through. What `npm publish` packs is the WORKING
  // TREE — so preferring the index, as this did for a while, let an unstaged
  // secret into a tarball instead. Identical content is scanned once, and each
  // copy keeps its own name, because a report has to say where to go and look.
  //
  // stderr goes nowhere on purpose: execFileSync forwards the child's by
  // default, so every object git could not resolve printed a two-line "fatal:"
  // into the report — noise that reads like a scanner failure and that the
  // catch was written to keep quiet about.
  const versions = new Map();
  const note = (body, where) => versions.set(body, versions.has(body) ? `${versions.get(body)}, ${where}` : where);
  if (e.sha) {
    try { note(execFileSync('git', ['cat-file', 'blob', e.sha], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }), 'index'); } catch { /* object gone */ }
  }
  try { note(readFileSync(e.path, 'utf8'), 'working tree'); } catch { /* deleted from disk */ }
  // Nothing gets skipped in silence again. A tracked path that yields no
  // readable copy at all is the shape every one of these misses has taken so
  // far, and each time the summary went on to count the file as clean.
  if (!versions.size) {
    console.log(`FAIL  ${e.name}: tracked, but no copy of it could be read — nothing was scanned`); bad++; continue;
  }
  for (const [body, where] of versions) {
    // Each copy on its own. Scanning the two of them glued together reported a
    // line number counted through the whole join, so a key on line 4 of a
    // four-line file was announced at line 45 and read like a false positive.
    const at = `${e.name} (${where})`;
    // A source file writes a multi-line postal address as one string with \n in
    // it — two literal characters, not a break. The word-boundary anchors then
    // see `n` running into the capital and match nothing, so an address inside a
    // string literal walked past the whole scan. Treat the escapes as the breaks
    // they stand for.
    const scan = body.replace(/\\[nrt]/g, ' ');
    for (const [re, what] of [...SECRETS, ...PERSONAL]) {
      const m = re.exec(scan);
      // Location and category only. Printing the match put the secret into the
      // CI log of the job whose entire purpose is to keep it out: an AWS key id
      // is 20 characters and fitted inside the excerpt whole.
      if (m) { console.log(`FAIL  ${at}:${scan.slice(0, m.index).split('\n').length}: ${what} (${m[0].length} chars)`); bad++; }
    }
    for (const m of body.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
      // `git@github.com:owner/repo` is an SSH URL, not somebody's address; the
      // trailing colon is what tells the two apart.
      if (m[0].startsWith('git@') && body[m.index + m[0].length] === ':') continue;
      // The address is the finding, and it is the thing that must not be echoed;
      // the domain is enough to find it.
      if (!MAIL_OK.test(m[0])) { console.log(`FAIL  ${at}: email address at @${m[0].split('@')[1]}`); bad++; }
    }
    // Compared NFC-folded: the names that leaked last time arrived from the
    // service in NFD, so a byte-exact search walked straight past them.
    for (const term of denylist || []) {
      if (nfc(scan).includes(term)) { console.log(`FAIL  ${at}: denylisted term (${term.length} chars)`); bad++; }
    }
  }
}

// A session/state file must never be tracked, whatever .gitignore says. The
// pattern matched `.env` exactly, so `.env.local` and `.env.production` — the
// ones people actually fill in — went straight past it.
for (const e of tracked) {
  if (/(^|\/)(state\.json|\.env(\..+)?|.*token.*cache.*)$/.test(e.bytes) && !/\.env\.(example|sample|template)$/.test(e.bytes)) {
    console.log(`FAIL  ${e.name}: session/credential file is tracked`); bad++;
  }
  if (/\.(pdf|png|jpg|jpeg)$/i.test(e.bytes)) { console.log(`FAIL  ${e.name}: a tracked document or screenshot — these repos have no reason to hold one`); bad++; }
}

// Commits carry an identity too, and no scan of the working tree can see it.
// One commit here once went out under a work address complete with an internal
// org code. On a shallow CI clone this sees only the tip, which is still worth
// checking — a bad identity is introduced at the tip, not retroactively.
try {
  const idents = new Set(execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(Boolean));
  for (const mail of idents) {
    if (!MAIL_OK.test(mail)) { console.log(`FAIL  commit identity is not anonymous (@${mail.split('@')[1]})`); bad++; }
  }
} catch { /* no history to inspect, e.g. an export rather than a clone */ }

if (!denylist) console.log(`note  no denylist at ${DENYLIST_PATH} — name check skipped`);
console.log(bad ? `\n${bad} problem(s)` : `ok    ${files.length} tracked files clean`);
process.exit(bad ? 1 : 0);
