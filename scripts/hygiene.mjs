#!/usr/bin/env node
// Repo hygiene: nothing secret, nothing personal, nothing accidentally staged.
// The personal-data scan exists because an external review caught exactly that
// leaking into documentation that claimed to contain none.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SECRETS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub PAT'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'private key'],
  [/"?access_token"?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/, 'hardcoded access token'],
];
// Personal detail that has no business in a public/shared repo. Deliberately
// narrow: counterparty names and identifiers, not ordinary German words.
const PERSONAL = [
  [/\bCH\d{2}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d?/, 'looks like an IBAN'],
  [/\b756\.\d{4}\.\d{4}\.\d{2}\b/, 'Swiss social-security number'],
  [/\bBE[ ]?\d{5,6}\b/, 'vehicle plate'],
];
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
  .filter(f => f && !/^(package-lock\.json|.*\.(png|jpg|jpeg|pdf|ico))$/.test(f));

let bad = 0;
for (const f of files) {
  let body;
  try { body = readFileSync(f, 'utf8'); } catch { continue; }
  for (const [re, what] of [...SECRETS, ...PERSONAL]) {
    const m = re.exec(body);
    if (m) { console.log(`FAIL  ${f}: ${what} — ${m[0].slice(0, 24)}…`); bad++; }
  }
}
// A session/state file must never be tracked, whatever .gitignore says.
for (const f of files) {
  if (/(^|\/)(state\.json|\.env|.*token.*cache.*)$/.test(f)) { console.log(`FAIL  ${f}: session/credential file is tracked`); bad++; }
}
console.log(bad ? `\n${bad} problem(s)` : `ok    ${files.length} tracked files clean`);
process.exit(bad ? 1 : 0);
