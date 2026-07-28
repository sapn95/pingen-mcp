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
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'private key'],
  [/"?access_token"?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/, 'hardcoded access token'],
];

// Addresses that may legitimately appear: the ones that identify nobody. The
// reserved names come from RFC 2606 and RFC 6761 — they cannot resolve, which
// is exactly why fixtures use them.
const MAIL_OK = /@(users\.noreply\.github\.com|anthropic\.com|(.+\.)?(example\.(com|org|net)|invalid|test|localhost))$/;

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

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
  .filter(f => f && !/^(package-lock\.json|.*\.(png|jpg|jpeg|pdf|ico))$/.test(f));

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
for (const f of files) {
  let body;
  try { body = readFileSync(f, 'utf8'); } catch { continue; }
  for (const [re, what] of [...SECRETS, ...PERSONAL]) {
    const m = re.exec(body);
    if (m) { console.log(`FAIL  ${f}: ${what} — ${m[0].slice(0, 24)}…`); bad++; }
  }
  for (const m of body.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    // `git@github.com:owner/repo` is an SSH URL, not somebody's address; the
    // trailing colon is what tells the two apart.
    if (m[0].startsWith('git@') && body[m.index + m[0].length] === ':') continue;
    if (!MAIL_OK.test(m[0])) { console.log(`FAIL  ${f}: email address — ${m[0]}`); bad++; }
  }
  // Compared NFC-folded: the names that leaked last time arrived from the
  // service in NFD, so a byte-exact search walked straight past them.
  for (const term of denylist || []) {
    if (nfc(body).includes(term)) { console.log(`FAIL  ${f}: denylisted term (${term.length} chars)`); bad++; }
  }
}

// A session/state file must never be tracked, whatever .gitignore says.
for (const f of files) {
  if (/(^|\/)(state\.json|\.env|.*token.*cache.*)$/.test(f)) { console.log(`FAIL  ${f}: session/credential file is tracked`); bad++; }
}

// Commits carry an identity too, and no scan of the working tree can see it.
// One commit here once went out under a work address complete with an internal
// org code. On a shallow CI clone this sees only the tip, which is still worth
// checking — a bad identity is introduced at the tip, not retroactively.
try {
  const idents = new Set(execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { encoding: 'utf8' })
    .split('\n').filter(Boolean));
  for (const mail of idents) {
    if (!MAIL_OK.test(mail)) { console.log(`FAIL  commit identity is not anonymous — ${mail}`); bad++; }
  }
} catch { /* no history to inspect, e.g. an export rather than a clone */ }

if (!denylist) console.log(`note  no denylist at ${DENYLIST_PATH} — name check skipped`);
console.log(bad ? `\n${bad} problem(s)` : `ok    ${files.length} tracked files clean`);
process.exit(bad ? 1 : 0);
