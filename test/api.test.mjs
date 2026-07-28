// Drives every tool over stdio against the local mock. No test here may reach
// api.pingen.com: PINGEN_API_BASE points at 127.0.0.1 and the credentials are
// fake, so the worst a bug can do is post a letter to a mock.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, ORG } from './mock-pingen.mjs';
import { startServer } from './client.mjs';

let mock, srv, out, pdf;
let draftId;

before(async () => {
  mock = await start();
  out = mkdtempSync(join(tmpdir(), 'pingen-test-'));
  pdf = join(out, 'Rechnung Muster.pdf');
  writeFileSync(pdf, '%PDF-1.4 test letter\n');
  srv = await startServer({ PINGEN_API_BASE: mock.base });
});
after(async () => { await srv?.stop(); await mock?.close(); });

describe('protocol', () => {
  test('advertises itself with the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(srv.init.result.serverInfo.name, pkg.name);
    assert.equal(srv.init.result.serverInfo.version, pkg.version);
  });

  test('every tool has a usable description and an object schema', async () => {
    const tools = await srv.tools();
    assert.equal(tools.length, 9, `expected the full tool set, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name}: description too thin`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: schema is not an object`);
      for (const r of t.inputSchema.required || []) {
        assert.ok(Object.hasOwn(t.inputSchema.properties, r), `${t.name}: required "${r}" undeclared`);
      }
    }
  });

  test('an unknown tool is answered, not crashed on', async () => {
    const { data } = await srv.call('pingen_teleport_letter');
    assert.match(data.error, /unknown tool/);
  });
});

describe('authentication', () => {
  test('obtains one token and reuses it for every later call', async () => {
    await srv.call('pingen_status');
    await srv.call('pingen_list_letters');
    assert.equal(mock.state.tokenGrants, 1, 'the token is cached, not re-fetched per call');
    assert.ok(mock.state.authHeaders.length > 1);
    assert.ok(mock.state.authHeaders.every(h => h.startsWith('Bearer ')), 'every call is authenticated');
  });

  test('the configured organisation is used without a lookup', async () => {
    const before = mock.state.calls.filter(c => c === 'GET /organisations').length;
    await srv.call('pingen_list_letters');
    const after = mock.state.calls.filter(c => c === 'GET /organisations').length;
    assert.equal(after, before, 'PINGEN_ORG_UUID makes the discovery call unnecessary');
    assert.ok(mock.state.calls.some(c => c === `GET /organisations/${ORG}/deliveries/letters`));
  });

  test('without a configured organisation the first one is discovered', async () => {
    const s = await startServer({ PINGEN_API_BASE: mock.base, PINGEN_ORG_UUID: '' });
    const { data } = await s.call('pingen_list_letters');
    assert.ok(Array.isArray(data.letters));
    assert.ok(mock.state.calls.includes('GET /organisations'));
    await s.stop();
  });

  test('an account without organisations says so instead of guessing', async () => {
    const bare = await start();
    bare.state.orgs = [];
    const s = await startServer({ PINGEN_API_BASE: bare.base, PINGEN_ORG_UUID: '' });
    const { raw, isError } = await s.call('pingen_list_letters');
    assert.ok(isError);
    assert.match(raw, /Keine Organisation/);
    await s.stop();
    await bare.close();
  });
});

describe('reading', () => {
  test('status names the organisations and which one is active', async () => {
    const { data } = await srv.call('pingen_status');
    assert.equal(data.active, ORG);
    assert.equal(data.organisations[0].name, 'Test Org');
    assert.equal(data.organisations[0].plan, 'free');
  });

  test('lists letters with status, tracking and a formatted price', async () => {
    const { data } = await srv.call('pingen_list_letters');
    const row = data.letters.find(l => l.id === 'ltr-1');
    assert.equal(row.status, 'sent');
    assert.equal(row.tracking, '98.12.345678.90');
    assert.equal(row.pages, 2);
    assert.equal(row.price, '1.85 CHF');
  });

  test('a letter with no price reports none rather than "undefined CHF"', async () => {
    const { data } = await srv.call('pingen_get_letter', { letter_id: 'ltr-2' });
    assert.equal(data.id, 'ltr-2');
    assert.equal(data.status, 'draft');
    assert.equal(data.price, undefined);
  });

  test('the page size reaches the API', async () => {
    await srv.call('pingen_list_letters', { limit: 3 });
    assert.ok(mock.state.urls.some(u => u.includes('page[limit]=3')), 'limit is passed through');
  });

  test('reads the tracking history', async () => {
    const { data } = await srv.call('pingen_letter_events', { letter_id: 'ltr-1' });
    assert.equal(data.events.length, 2);
    assert.equal(data.events[0].type, 'letter.created');
    assert.equal(data.events[0].at, '2026-07-01T09:00:00+00:00');
  });

  test('an unknown letter surfaces the upstream 404', async () => {
    const { raw, isError } = await srv.call('pingen_get_letter', { letter_id: 'nope' });
    assert.ok(isError);
    assert.match(raw, /404/);
  });
});

describe('sending', () => {
  test('uploads the PDF and creates a draft, mailing nothing', async () => {
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
    draftId = data.created.id;
    assert.equal(data.created.status, 'draft');
    assert.match(data.note, /DRAFT/);

    const sent = mock.state.created.at(-1);
    assert.equal(sent.auto_send, false, 'auto_send defaults to false');
    assert.equal(sent.address_position, 'left');
    assert.equal(sent.file_original_name, 'Rechnung Muster.pdf', 'the original file name travels with it');
    assert.equal(sent.file_url_signature, 'sig-1');
    assert.equal(sent.delivery_product, undefined, 'no product is invented for a draft');

    assert.equal(mock.state.uploads.at(-1).bytes.toString(), '%PDF-1.4 test letter\n', 'the real bytes were PUT');
    assert.ok(!mock.state.calls.some(c => c.endsWith('/send')), 'nothing was submitted');
  });

  test('passes the product and address window through when given', async () => {
    await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'cheap', address_position: 'right' });
    const sent = mock.state.created.at(-1);
    assert.equal(sent.delivery_product, 'cheap');
    assert.equal(sent.address_position, 'right');
  });

  test('auto_send=true is reported as a send, not as a draft', async () => {
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    assert.equal(mock.state.created.at(-1).auto_send, true);
    assert.match(data.note, /versandt/);
  });

  test('submits a draft with PATCH and the documented print defaults', async () => {
    const { data } = await srv.call('pingen_submit_letter', { letter_id: draftId, delivery_product: 'fast', confirm: true });
    assert.equal(data.submitted.id, draftId);
    assert.ok(mock.state.calls.includes(`PATCH /organisations/${ORG}/deliveries/letters/${draftId}/send`));
    const sub = mock.state.submitted.at(-1);
    assert.deepEqual(sub.attributes, { delivery_product: 'fast', print_mode: 'simplex', print_spectrum: 'color' });
  });

  test('print mode and spectrum can be overridden', async () => {
    await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'cheap', print_mode: 'duplex', print_spectrum: 'grayscale', confirm: true });
    const sub = mock.state.submitted.at(-1);
    assert.equal(sub.attributes.print_mode, 'duplex');
    assert.equal(sub.attributes.print_spectrum, 'grayscale');
  });

  test('cancels a submitted letter', async () => {
    const { data } = await srv.call('pingen_cancel_letter', { letter_id: draftId });
    assert.equal(data.cancelled, draftId);
    assert.ok(mock.state.cancelled.includes(draftId));
  });

  test('deletes a draft outright', async () => {
    const { data: created } = await srv.call('pingen_send_letter', { file_path: pdf });
    const { data } = await srv.call('pingen_delete_letter', { letter_id: created.created.id, confirm: true });
    assert.equal(data.deleted, created.created.id);
    assert.ok(mock.state.deleted.includes(created.created.id));
    const { isError } = await srv.call('pingen_get_letter', { letter_id: created.created.id });
    assert.ok(isError, 'it is really gone');
  });
});

describe('failure paths', () => {
  test('a missing PDF fails before anything is uploaded', async () => {
    const before = { created: mock.state.created.length, slots: mock.state.calls.filter(c => c === 'GET /file-upload').length };
    const { raw, isError } = await srv.call('pingen_send_letter', { file_path: join(out, 'absent.pdf') });
    assert.ok(isError);
    assert.match(raw, /ENOENT|no such file/i);
    assert.equal(mock.state.created.length, before.created, 'no letter was created');
    assert.equal(mock.state.calls.filter(c => c === 'GET /file-upload').length, before.slots, 'no upload slot was even requested');
  });

  test('a file that is not a PDF never leaves the machine', async () => {
    const notPdf = join(out, 'secrets.txt');
    writeFileSync(notPdf, 'BEGIN PRIVATE KEY not a letter at all');
    const before = mock.state.uploads.length;
    const { raw, isError } = await srv.call('pingen_send_letter', { file_path: notPdf });
    assert.ok(isError);
    assert.match(raw, /Keine PDF-Datei/);
    assert.equal(mock.state.uploads.length, before, 'nothing was PUT');
    assert.ok(!mock.state.uploads.some(u => u.bytes.includes('PRIVATE KEY')), 'and certainly not that');
  });

  test('an upload slot without a URL is refused, not PUT into the void', async () => {
    mock.state.slotBroken = true;
    const { raw, isError } = await srv.call('pingen_send_letter', { file_path: pdf });
    mock.state.slotBroken = false;
    assert.ok(isError);
    assert.match(raw, /Upload-Slot ohne URL/);
  });

  test('a failed byte upload is reported with its status', async () => {
    mock.state.uploadStatus = 503;
    const { raw, isError } = await srv.call('pingen_send_letter', { file_path: pdf });
    mock.state.uploadStatus = 200;
    assert.ok(isError);
    assert.match(raw, /PUT file → 503/);
  });

  test('an upstream 500 is surfaced as a tool error', async () => {
    const { raw, isError } = await srv.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    assert.ok(isError);
    assert.match(raw, /500/);
  });
});

describe('downloads', () => {
  test('saves the PDF when the API answers with the bytes', async () => {
    const p = join(out, 'direct.pdf');
    const { data } = await srv.call('pingen_download_letter', { letter_id: 'ltr-1', output_path: p });
    assert.equal(data.saved, p);
    assert.ok(existsSync(p));
    assert.match(readFileSync(p, 'utf8'), /^%PDF/);
    assert.equal(data.bytes, readFileSync(p).length);
  });

  test('follows the pointer when the API answers with a URL instead', async () => {
    const p = join(out, 'pointer.pdf');
    await srv.call('pingen_download_letter', { letter_id: 'ltr-2', output_path: p });
    assert.match(readFileSync(p, 'utf8'), /fetched-from-blob/);
  });

  test('says the file is not ready rather than writing an empty one', async () => {
    const p = join(out, 'never.pdf');
    const { raw, isError } = await srv.call('pingen_download_letter', { letter_id: 'ltr-3', output_path: p });
    assert.ok(isError);
    assert.match(raw, /Kein Datei-URL/);
    assert.ok(!existsSync(p), 'nothing was written');
  });

  test('an unwritable destination is an error, not a silent no-op', async () => {
    const { raw, isError } = await srv.call('pingen_download_letter', { letter_id: 'ltr-1', output_path: join(out, 'no', 'such', 'dir.pdf') });
    assert.ok(isError);
    assert.match(raw, /ENOENT/);
  });
});
