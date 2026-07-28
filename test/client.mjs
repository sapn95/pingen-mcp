// Minimal MCP client over stdio, so tests drive the server exactly as a real
// client would rather than importing its internals.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

// A `security` that finds nothing, first on PATH for every server under test.
// Belt and braces: if the "a set variable wins" rule ever regressed, a test
// with a blanked credential would otherwise go shopping in the developer's
// login keychain and authenticate as the real Pingen account. A test that wants
// a keychain answer passes its own PATH.
//
// It complains on stderr on the way out, because the real one does and because
// execFileSync passes a child's stderr on to ours: a silent stub let a server
// that echoed the keychain's grumbling look clean to every test in the suite.
const NULL_KEYCHAIN = mkdtempSync(join(tmpdir(), 'pingen-null-keychain-'));
writeFileSync(join(NULL_KEYCHAIN, 'security'),
  '#!/bin/sh\necho "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2\nexit 44\n',
  { mode: 0o755 });

// Credentials every server under test starts with. They are fake on purpose:
// combined with PINGEN_API_BASE pointing at the local mock, no test can reach
// api.pingen.com, and nothing can be physically mailed.
// The secret deliberately contains characters that change shape in transit —
// `"` is escaped inside JSON, `/` and `+` are percent-encoded in a form body —
// so the redaction is tested against every form it could be echoed back in.
export const FAKE = {
  PINGEN_CLIENT_ID: 'test-client-id-0000',
  PINGEN_CLIENT_SECRET: 'test-client-secret-"shhh"/x+y',
  PINGEN_ORG_UUID: 'org-test-1',
};

// 30s per call is generous for a local mock, deliberately: on a loaded CI runner
// a tighter budget fails a correct server for want of a CPU slice.
export async function startServer(env = {}, { timeout = 30000 } = {}) {
  // `undefined` means "unset this variable for the child", which is how a test
  // asks for the keychain path; an empty string means "set, but empty".
  // PINGEN_AUTH_BASE is inherited from the developer's shell otherwise, and a
  // suite that says it cannot reach the network would then mint tokens against
  // whatever that variable happens to point at. Everything a test does not name
  // explicitly is pinned to the mock or blanked.
  const merged = {
    ...process.env, ...FAKE,
    // Removed, not set: setting it would make the server report
    // PINGEN_AUTH_BASE as the variable at fault when the API base is the one
    // that is wrong. Absent, the production fallback to the API host applies,
    // which is the behaviour under test.
    PINGEN_AUTH_BASE: undefined,
    PATH: `${NULL_KEYCHAIN}:${process.env.PATH}`,
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];

  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env: merged });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', raw => {
    const line = raw.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    // unref: a pending timeout must not hold the test runner's event loop open
    setTimeout(() => reject(new Error(`${method} timed out after ${timeout}ms`)), timeout).unref();
  });

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    init,
    stderr: () => stderr,
    async tools() { return (await rpc('tools/list')).result.tools; },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      const t = (r.result?.content || []).map(c => c.text).join('\n');
      let parsed;
      try { parsed = JSON.parse(t); } catch { parsed = t; }
      return { raw: t, isError: !!r.result?.isError, data: parsed && typeof parsed === 'object' ? parsed : {}, parsed };
    },
    // Close stdin and let the server exit on its own: killed outright it never
    // flushes its V8 coverage, and the run would under-report every child.
    stop() {
      child.stdin.end();
      return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const t = setTimeout(() => { child.kill(); resolve(); }, 5000);
        t.unref();
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}
