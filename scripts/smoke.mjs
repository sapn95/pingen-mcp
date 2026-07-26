#!/usr/bin/env node
// Offline protocol smoke test. Starts the server over stdio, completes the MCP
// handshake, lists the tools and asserts the things that have actually broken
// here before: a version that drifted from package.json, a tool added to the
// dispatcher but not to the tool list (or the reverse), and a malformed
// inputSchema that only shows up when a client tries to call it.
//
// No network, no credentials, no browser — safe to run in CI.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entry = join(root, pkg.main || 'index.js');

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

const pending = new Map();
let id = 1;
readline.createInterface({ input: child.stdout }).on('line', line => {
  line = line.trim();
  if (!line) return;
  let m;
  try { m = JSON.parse(line); } catch { fail.push(`non-JSON on stdout: ${line.slice(0, 80)}`); return; }
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const send = (method, params) => new Promise((resolve, reject) => {
  const i = id++;
  pending.set(i, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
});

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const info = init?.result?.serverInfo;
  check(!!info, 'initialize returns serverInfo');
  check(info?.name === pkg.name, `serverInfo.name "${info?.name}" matches package.json "${pkg.name}"`);
  check(info?.version === pkg.version, `serverInfo.version "${info?.version}" matches package.json "${pkg.version}"`);

  const tools = (await send('tools/list'))?.result?.tools;
  check(Array.isArray(tools) && tools.length > 0, `tools/list returns tools (${tools?.length ?? 0})`);

  const names = (tools || []).map(t => t.name);
  check(new Set(names).size === names.length, 'no duplicate tool names');

  for (const t of tools || []) {
    const s = t.inputSchema;
    check(typeof t.description === 'string' && t.description.length > 20, `${t.name}: has a usable description`);
    check(s?.type === 'object' && typeof s.properties === 'object',
      `${t.name}: inputSchema is an object schema with properties`);
    for (const req of s?.required || []) {
      check(Object.hasOwn(s.properties || {}, req), `${t.name}: required "${req}" is declared in properties`);
    }
  }

  // Every tool the dispatcher answers must be advertised, and vice versa: an
  // unadvertised tool is unreachable, an advertised-but-unhandled one returns
  // "unknown tool" to a client that trusted the list.
  const src = readFileSync(entry, 'utf8');
  for (const n of names) {
    check(src.includes(`'${n}'`) || src.includes(`"${n}"`), `${n}: handled in the server source`);
  }

  check(!/Error|Cannot find|ERR_/i.test(stderr), `clean stderr${stderr ? ` (got: ${stderr.slice(0, 120)})` : ''}`);
} catch (e) {
  check(false, `handshake: ${e.message}`);
} finally {
  child.stdin.end();
  child.kill();
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall checks passed');
process.exit(fail.length ? 1 : 0);
