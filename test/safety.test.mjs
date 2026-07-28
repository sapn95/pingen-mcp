// The properties that matter more than any feature: no letter leaves the
// building without an explicit second step, and no credential ever leaves this
// process. Everything here runs against the local mock with fake credentials.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, TOKEN } from './mock-pingen.mjs';
import { startServer, FAKE } from './client.mjs';

let mock, srv, out, pdf;

// A stand-in for macOS `security`, so the keychain path can be exercised
// without ever touching the real login keychain — and so a test can prove the
// keychain was *not* consulted. A fresh one per test: the log is the assertion.
function keychainShim({ empty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pingen-shim-'));
  const log = join(dir, 'security.log');
  // `security find-generic-password -a pingen -s <service> -w` → $5 is the service.
  writeFileSync(join(dir, 'security'), `#!/bin/sh
echo "$5" >> "${log}"
${empty ? 'exit 44' : `case "$5" in
  pingen-mcp-client-id) echo '${FAKE.PINGEN_CLIENT_ID}' ;;
  pingen-mcp-client-secret) echo '${FAKE.PINGEN_CLIENT_SECRET}' ;;
  pingen-mcp-org-uuid) echo '${FAKE.PINGEN_ORG_UUID}' ;;
  *) exit 44 ;;
esac`}
`, { mode: 0o755 });
  // The shim goes first on PATH so the real /usr/bin/security is never reached.
  return { path: `${dir}:${process.env.PATH}`, asked: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

before(async () => {
  mock = await start();
  out = mkdtempSync(join(tmpdir(), 'pingen-safety-'));
  pdf = join(out, 'letter.pdf');
  writeFileSync(pdf, '%PDF-1.4 safety\n');
  srv = await startServer({ PINGEN_API_BASE: mock.base });
});
after(async () => { await srv?.stop(); await mock?.close(); });

describe('nothing is mailed by accident', () => {
  test('send_letter creates a draft and submits nothing', async () => {
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
    assert.equal(data.created.status, 'draft');
    assert.equal(mock.state.submitted.length, 0, 'no letter was submitted');
    assert.ok(!mock.state.calls.some(c => c.endsWith('/send')), 'the send endpoint was never called');
  });

  test('a truthy-but-not-boolean auto_send still yields a draft', async () => {
    // The schema says boolean, but the protocol does not enforce it: a client
    // sending the string "true" must not cause a letter to be posted.
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, auto_send: 'true' });
    assert.equal(data.created.status, 'draft');
    assert.equal(mock.state.created.at(-1).auto_send, false);
    assert.match(data.note, /DRAFT/);
  });

  test('submitting without confirm mails nothing and says what is missing', async () => {
    // The most consequential call in the suite — it prints, franks and posts a
    // physical letter, and no amount of apologising gets it back.
    const before = mock.state.submitted.length;
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast' });
    assert.match(data.refused, /confirm:true/);
    assert.equal(mock.state.submitted.length, before, 'and nothing left the building');
  });

  test('a truthy-but-not-boolean confirm is not a confirmation', async () => {
    // Same reasoning as auto_send above: the schema is not enforced on the wire.
    const before = mock.state.submitted.length;
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: 'true' });
    assert.match(data.refused, /confirm:true/);
    assert.equal(mock.state.submitted.length, before);
  });

  test('deleting without confirm removes nothing', async () => {
    const { data } = await srv.call('pingen_delete_letter', { letter_id: 'ltr-3' });
    assert.match(data.refused, /confirm:true/);
    assert.match(data.note, /pingen_cancel_letter/, 'it names the safe alternative');
    assert.ok(!mock.state.calls.some(c => c.startsWith('DELETE ')), 'nothing was deleted');
  });

  test('a list limit cannot smuggle extra query parameters into the request', async () => {
    // The schema says number; nothing enforces it. A string went into the query
    // verbatim, so the caller could append parameters of their own choosing.
    await srv.call('pingen_list_letters', { limit: '5&filter[status]=sent' });
    // state.calls holds paths only, so the query has to come from state.urls —
    // a query-string assertion against the path list can never fail.
    const listed = mock.state.urls.filter(u => u.includes('/deliveries/letters?'));
    assert.ok(listed.length, 'the call was made');
    assert.ok(!listed.some(u => u.includes('filter')), `smuggled a parameter: ${listed.at(-1)}`);
    // Not a partial parse of "5&…" either: half-reading hostile input is how
    // this class of bug comes back. Unusable means the documented default.
    assert.match(listed.at(-1), /page%5Blimit%5D=20|page\[limit\]=20/, 'it fell back to the default');

    await srv.call('pingen_list_letters', { limit: 5 });
    assert.match(mock.state.urls.at(-1), /page%5Blimit%5D=5|page\[limit\]=5/, 'a real number is still honoured');
  });

  test('reading tools never touch the send endpoint', async () => {
    await srv.call('pingen_status');
    await srv.call('pingen_list_letters');
    await srv.call('pingen_get_letter', { letter_id: 'ltr-1' });
    await srv.call('pingen_letter_events', { letter_id: 'ltr-1' });
    assert.equal(mock.state.submitted.length, 0);
  });

  test('submitting is a PATCH, and a POST to /send is never attempted', async () => {
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    assert.equal(data.submitted.id, 'ltr-2');
    assert.equal(mock.state.submitted.length, 1, 'exactly the one letter we asked for');
    const sendCalls = mock.state.calls.filter(c => c.endsWith('/send'));
    assert.deepEqual([...new Set(sendCalls.map(c => c.split(' ')[0]))], ['PATCH'],
      'the API only accepts PATCH here; a POST would 405 and quietly mail nothing');
  });
});

describe('credentials never leave the process', () => {
  test('no tool result and no stderr contains the token or the secret', async () => {
    const results = [];
    for (const [name, args] of [
      ['pingen_status', {}],
      ['pingen_list_letters', {}],
      ['pingen_get_letter', { letter_id: 'ltr-1' }],
      ['pingen_letter_events', { letter_id: 'ltr-1' }],
      ['pingen_send_letter', { file_path: pdf }],
      ['pingen_download_letter', { letter_id: 'ltr-1', output_path: join(out, 'x.pdf') }],
      ['pingen_cancel_letter', { letter_id: 'ltr-1' }],
      ['pingen_delete_letter', { letter_id: 'ltr-3', confirm: true }],
    ]) {
      results.push((await srv.call(name, args)).raw);
    }
    const blob = results.join('\n') + srv.stderr();
    assert.ok(!blob.includes(TOKEN), 'the access token must not surface');
    assert.ok(!blob.includes(FAKE.PINGEN_CLIENT_SECRET), 'the client secret must not surface');
    assert.equal(srv.stderr(), '', 'the server logs nothing at all on stderr');
  });

  test('an upstream error that quotes the bearer token is redacted', async () => {
    const { raw, isError } = await srv.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    assert.ok(isError);
    assert.match(raw, /500/, 'the failure is still reported');
    assert.ok(!raw.includes(TOKEN), 'but not with the token in it');
    assert.match(raw, /\*\*\*/, 'it is masked, not merely truncated');
  });

  test('a rejected grant does not echo the client secret back, in any encoding', async () => {
    const bad = await start({ tokenStatus: 401 });
    const s = await startServer({ PINGEN_API_BASE: bad.base });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /Token-Fehler 401/, 'the failure is still legible');
    const secret = FAKE.PINGEN_CLIENT_SECRET;
    for (const [form, how] of [
      [secret, 'verbatim'],
      [JSON.stringify(secret).slice(1, -1), 'JSON-escaped'],
      [encodeURIComponent(secret), 'percent-encoded'],
    ]) {
      assert.ok(!raw.includes(form), `the secret leaked ${how}: ${raw}`);
    }
    // Deliberately not asserting a "***" mask: the secret is never put into the
    // message at all, which is stronger than masking it. What the message must
    // do is say which credential the service rejected, so the reader knows what
    // to go and check.
    assert.match(raw, /invalid_client/, 'it says which credential was refused');
    assert.equal(s.stderr(), '');
    await s.stop();
    await bad.close();
  });

  test('a grant with no access_token is an error, not a silent "Bearer undefined"', async () => {
    const bad = await start({ tokenBody: '{"token_type":"bearer","expires_in":3600}' });
    const s = await startServer({ PINGEN_API_BASE: bad.base });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /ohne access_token/);
    await s.stop();
    await bad.close();
  });
});

describe('configuration is taken literally', () => {
  test('an empty credential is authoritative and does not fall back to the keychain', async () => {
    const kc = keychainShim();
    const s = await startServer({ PINGEN_API_BASE: mock.base, PINGEN_CLIENT_SECRET: '', PATH: kc.path });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /Keine Pingen-Credentials/);
    assert.ok(!kc.asked().includes('pingen-mcp-client-secret'),
      'a blank variable must not send the server shopping in the login keychain');
    await s.stop();
  });

  test('an absent credential does come from the keychain', async () => {
    const kc = keychainShim();
    const s = await startServer({
      PINGEN_API_BASE: mock.base,
      PINGEN_CLIENT_ID: undefined,
      PINGEN_CLIENT_SECRET: undefined,
      PINGEN_ORG_UUID: undefined,
      PATH: kc.path,
    });
    const { data, isError } = await s.call('pingen_list_letters');
    assert.ok(!isError, 'the keychain credentials authenticate');
    assert.ok(Array.isArray(data.letters));
    const asked = kc.asked();
    for (const svc of ['pingen-mcp-client-id', 'pingen-mcp-client-secret', 'pingen-mcp-org-uuid']) {
      assert.ok(asked.includes(svc), `${svc} was read from the keychain`);
    }
    await s.stop();
  });

  test('a keychain with no entry degrades to a clear error, not a crash', async () => {
    const kc = keychainShim({ empty: true });
    const s = await startServer({
      PINGEN_API_BASE: mock.base,
      PINGEN_CLIENT_ID: undefined,
      PINGEN_CLIENT_SECRET: undefined,
      PINGEN_ORG_UUID: undefined,
      PATH: kc.path,
    });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /Keine Pingen-Credentials/);
    assert.equal(s.stderr(), '', 'a missing keychain entry is not noise on stderr');
    await s.stop();
  });

  test('no credentials anywhere is a clear error and no API traffic', async () => {
    const empty = await start();
    // The shim is on PATH even though nothing should consult it: if the
    // env-wins rule ever regressed, this test would otherwise wander into the
    // developer's real login keychain looking for a real Pingen account.
    const s = await startServer({
      PINGEN_API_BASE: empty.base,
      PINGEN_CLIENT_ID: '',
      PINGEN_CLIENT_SECRET: '',
      PATH: keychainShim({ empty: true }).path,
    });
    const { raw, isError } = await s.call('pingen_status');
    assert.ok(isError);
    assert.match(raw, /Keine Pingen-Credentials/);
    assert.equal(empty.state.calls.length, 0, 'it never called out');
    await s.stop();
    await empty.close();
  });

  test('a blank API base fails loudly instead of falling back to production', async () => {
    const s = await startServer({ PINGEN_API_BASE: '' });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /PINGEN_API_BASE/);
    await s.stop();
  });

  test('a trailing slash on the API base does not produce a double slash', async () => {
    const s = await startServer({ PINGEN_API_BASE: `${mock.base}/` });
    const { isError } = await s.call('pingen_list_letters');
    assert.ok(!isError);
    assert.ok(!mock.state.calls.some(c => c.includes('//')), 'no path was requested with a doubled slash');
    await s.stop();
  });
});
