// Drives every tool over stdio against the local mock. No test here may reach
// api.pingen.com: PINGEN_API_BASE points at 127.0.0.1 and the credentials are
// fake, so the worst a bug can do is post a letter to a mock.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
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

  test('an unknown tool is an error, and authenticates nothing on the way', async () => {
    // It used to come back as a perfectly successful result, and only after
    // resolving an organisation on behalf of a call that was never valid.
    const before = mock.state.calls.length;
    const { raw, isError } = await srv.call('pingen_teleport_letter');
    assert.equal(isError, true, 'a client that asked for nothing real must be told so');
    assert.match(raw, /unknown tool/);
    assert.equal(mock.state.calls.length, before, 'and no request was made for it');
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

  test('two organisations is a question, not a default', async () => {
    // Taking the first would decide — silently — which account pays for and
    // franks the letter. Only zero and one were ever covered here.
    const two = await start();
    two.state.orgs = [
      { id: 'org-a', type: 'organisations', attributes: { name: 'Example One' } },
      { id: 'org-b', type: 'organisations', attributes: { name: 'Example Two' } },
    ];
    const s2 = await startServer({ PINGEN_API_BASE: two.base, PINGEN_ORG_UUID: '' });
    const { raw, isError } = await s2.call('pingen_list_letters');
    assert.ok(isError, 'it chose one');
    assert.match(raw, /PINGEN_ORG_UUID/);
    assert.match(raw, /org-a/, 'and lists them so the choice can be made');
    assert.ok(!two.state.calls.some(c => c.includes('/deliveries/letters')), 'it asked an organisation anyway');
    await s2.stop();
    await two.close();
  });

  test('a page of one organisation is not an account with one organisation', async () => {
    // The guard above only ever asked "how many came back", and a collection
    // that paginates answers that question about the page, not the account.
    // Three organisations behind a page size of one look exactly like one
    // organisation — so the guard stood down, the first entry of an
    // alphabetical page became the account the letter was billed to, and
    // nothing was said about it. This is the same page-is-not-the-list lesson
    // both letter listings were taught, in the one place where getting it wrong
    // decides who pays.
    const many = await start();
    // The first entry is a working organisation on purpose: pointed at one the
    // mock refuses, the wrong choice would fail on its own and look like the
    // guard had held. It has to succeed for the harm to be visible — a private
    // letter uploaded, created and billed to an account nobody picked.
    many.state.orgs = [
      { id: ORG, type: 'organisations', attributes: { name: 'Example One' } },
      { id: 'org-b', type: 'organisations', attributes: { name: 'Example Two' } },
      { id: 'org-c', type: 'organisations', attributes: { name: 'Example Three' } },
    ];
    many.state.orgPageMax = 1;                      // the API caps the page, whatever we ask
    const s = await startServer({ PINGEN_API_BASE: many.base, PINGEN_ORG_UUID: '' });
    const { raw, isError } = await s.call('pingen_send_letter', { file_path: pdf });
    const created = many.state.created.length;
    const uploads = many.state.uploads.length;
    await s.stop();
    await many.close();
    assert.equal(created, 0, 'a letter was created and billed to an account nobody picked');
    assert.equal(uploads, 0, 'its contents were uploaded to an account nobody picked');
    assert.ok(isError, 'it chose one off a page it knew was cut off');
    assert.match(raw, /PINGEN_ORG_UUID/, `it did not say how to answer the question: ${raw}`);
  });

  test('an organisation on a later page is not a broken configuration', async () => {
    // The mirror image, in pingen_status: absent from the page it read is not
    // absent from the account. A correct PINGEN_ORG_UUID that happened to sort
    // onto page two came back as "gehört zu keiner erreichbaren Organisation" —
    // a confident, false answer that sends the reader off to fix a setting that
    // was never broken.
    const many = await start();
    many.state.orgs = [
      { id: 'org-a', type: 'organisations', attributes: { name: 'Example One' } },
      { id: 'org-b', type: 'organisations', attributes: { name: 'Example Two' } },
      { id: 'org-c', type: 'organisations', attributes: { name: 'Example Three' } },
    ];
    many.state.orgPageMax = 1;
    const s = await startServer({ PINGEN_API_BASE: many.base, PINGEN_ORG_UUID: 'org-c' });
    const { data } = await s.call('pingen_status');
    await s.stop();
    await many.close();
    assert.equal(data.active, 'org-c', `declared a working configuration broken: ${JSON.stringify(data)}`);
    assert.equal(data.error, undefined, `and reported it as an error: ${data.error}`);
    assert.equal(data.truncated, true, 'while still saying the list was only a page');
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

  test('letters come back newest first, as the API was asked', async () => {
    // The mock used to return insertion order whatever was asked for, so a
    // regression that dropped the sort — or reversed it — was invisible.
    const { data } = await srv.call('pingen_list_letters');
    const ids = data.letters.map(l => l.id);
    assert.deepEqual(ids.slice(0, 3), ['ltr-1', 'ltr-3', 'ltr-2'], `wrong order: ${ids}`);
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

  test('one page of letters is not the whole list, and says so', async () => {
    // pingen_letter_events was taught this and pingen_list_letters was not, so
    // an account with more letters than the page size got the newest few back
    // as though they were all of them — and "no, nothing went to that address"
    // then came out of a list nobody had read to the end.
    const { data } = await srv.call('pingen_list_letters', { limit: 2 });
    assert.equal(data.letters.length, 2);
    assert.equal(data.truncated, true, `handed back ${data.letters.length} of ${mock.state.letters.length} without a word`);
    assert.match(data.hint, /limit/);
  });

  test('a list that does fit is not announced as truncated', async () => {
    // The other half of it: a warning on every complete answer is noise, and
    // noise is how a real one gets read past.
    const { data } = await srv.call('pingen_list_letters', { limit: 100 });
    assert.equal(data.letters.length, mock.state.letters.length);
    assert.equal(data.truncated, undefined, 'cried wolf over a complete list');
  });

  test('at the largest page it stops asking for a larger one', async () => {
    // The truncation note told a caller who had already asked for 100 to raise
    // the limit, which is advice nobody can follow: 100 is the cap and there is
    // no page parameter, so the older letters are not reachable through this
    // tool at all. A model that is told to raise a limit it is already at
    // raises it again, gets the same hundred back, and asks a paid API in a
    // circle.
    const many = await start();
    many.state.letters = Array.from({ length: 150 }, (_, i) => ({
      id: `ltr-${String(i).padStart(3, '0')}`,
      type: 'letters',
      attributes: { status: 'sent', created_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00+00:00` },
    }));
    const s = await startServer({ PINGEN_API_BASE: many.base });
    const { data } = await s.call('pingen_list_letters', { limit: 100 });
    await s.stop();
    await many.close();
    assert.equal(data.letters.length, 100);
    assert.equal(data.truncated, true, 'it still has to say the list is not the whole list');
    assert.doesNotMatch(data.hint, /erhöhen/, `told to raise a limit already at the maximum: ${data.hint}`);
    assert.match(data.hint, /pingen_get_letter/, 'and says what is left to do instead');
  });

  test('reads the tracking history, newest first', async () => {
    // Newest first is not cosmetic here: the tool reads one page and stops, so
    // the sort decides whether that page is the end of the history or the
    // beginning of it. Asked the other way round, a letter that has been
    // delivered comes back looking like one that has only just been created —
    // and the assertion used to expect exactly that order, because the mock
    // handed these over in insertion order whatever the query said.
    const { data } = await srv.call('pingen_letter_events', { letter_id: 'ltr-1' });
    assert.equal(data.events.length, 2);
    assert.equal(data.events[0].type, 'letter.sent', `oldest first: ${data.events.map(e => e.type)}`);
    assert.equal(data.events[0].at, '2026-07-01T09:30:00+00:00');
    assert.equal(data.events[1].type, 'letter.created');
    assert.ok(mock.state.urls.some(u => u.includes('/events?') && u.includes('sort=-emitted_at')), 'the sort was asked for');
    assert.equal(data.truncated, undefined, 'cried wolf over a complete history');
  });

  test('a history page that volunteers nothing about the rest is still not the whole history', async () => {
    // This tool was the first one taught that a page is not the list, and then
    // pingen_list_letters was taught the same lesson better: when the answer
    // carries neither a next link nor a total, a page that came back exactly
    // full is the last evidence there is that something was cut off. That third
    // branch was never brought back here — and could not have been, because a
    // caller that never says how big a page it wants cannot tell a full one
    // from a short one. A letter with a long trail then came back looking like
    // one whose story had simply ended, which is the answer "no, it never went
    // anywhere" is read off.
    const many = await start();
    many.state.eventTrail = Array.from({ length: 150 }, (_, i) => ({
      id: `ev-${String(i).padStart(3, '0')}`,
      type: 'letter_events',
      attributes: { type: 'letter.status', emitted_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00+00:00` },
    }));
    many.state.eventsQuiet = true;
    const s = await startServer({ PINGEN_API_BASE: many.base });
    const { data } = await s.call('pingen_letter_events', { letter_id: 'ltr-1' });
    const asked = many.state.urls.filter(u => u.includes('/events')).at(-1);
    await s.stop();
    await many.close();
    assert.match(asked, /page%5Blimit%5D=100|page\[limit\]=100/, `it never said how big a page it wanted: ${asked}`);
    assert.equal(data.events.length, 100);
    assert.equal(data.truncated, true, `handed back ${data.events.length} of 150 without a word`);
    assert.match(data.hint, /ältesten/, 'newest-first means it is the old end that is missing');
  });

  test('a short history with no metadata is not announced as truncated', async () => {
    // The other half: a warning on every complete answer is noise, and noise is
    // how a real one gets read past.
    const few = await start();
    few.state.eventsQuiet = true;
    const s = await startServer({ PINGEN_API_BASE: few.base });
    const { data } = await s.call('pingen_letter_events', { letter_id: 'ltr-1' });
    await s.stop();
    await few.close();
    assert.equal(data.events.length, 2);
    assert.equal(data.truncated, undefined, 'cried wolf over a complete history');
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
    assert.doesNotMatch(data.note, /nichts versandt/, 'the draft note also contains "versandt"');
    assert.match(data.note, /wird versandt/);
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

  test('a file descriptor is not the letter to mail', async () => {
    // The mirror of the output_path check, and the more consequential half:
    // readFileSync takes a number as a file descriptor, so file_path: 0 reads
    // this server's own MCP input stream and a character device never ends.
    // Only the output side of that pair had ever been exercised.
    const before = { slots: mock.state.calls.filter(c => c === 'GET /file-upload').length, uploads: mock.state.uploads.length };
    for (const bad of [0, 1, null, '', '   ', { path: pdf }]) {
      const { raw, isError } = await srv.call('pingen_send_letter', { file_path: bad });
      assert.ok(isError, `file_path ${JSON.stringify(bad)} was accepted`);
      assert.match(raw, /file_path muss ein Pfad sein/);
    }
    assert.equal(mock.state.calls.filter(c => c === 'GET /file-upload').length, before.slots, 'an upload slot was requested for it');
    assert.equal(mock.state.uploads.length, before.uploads, 'something was PUT for it');
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
  test('a file descriptor is not an output path', async () => {
    // writeFileSync takes a number as an fd: output_path 2 wrote the letter to
    // stderr and 1 wrote it into the MCP stream itself.
    for (const bad of [2, 1, '', null]) {
      const { raw, isError } = await srv.call('pingen_download_letter', { letter_id: 'ltr-1', output_path: bad });
      assert.ok(isError, `output_path ${JSON.stringify(bad)} was accepted`);
      assert.match(raw, /muss ein Pfad sein|output_path/);
    }
    assert.ok(!srv.stderr().includes('%PDF'), 'a letter reached stderr');
  });

  test('a destination symlink is refused rather than followed', async () => {
    const target = join(out, 'not-the-letter.txt');
    writeFileSync(target, 'do not overwrite me');
    const link = join(out, 'link.pdf');
    symlinkSync(target, link);
    const { isError } = await srv.call('pingen_download_letter', { letter_id: 'ltr-1', output_path: link });
    assert.ok(isError, 'the symlink was followed');
    assert.equal(readFileSync(target, 'utf8'), 'do not overwrite me');
  });

  test('saves the PDF when the API answers with the bytes', async () => {
    const p = join(out, 'direct.pdf');
    const { data } = await srv.call('pingen_download_letter', { letter_id: 'ltr-1', output_path: p });
    assert.equal(data.saved, p);
    assert.ok(existsSync(p));
    assert.match(readFileSync(p, 'utf8'), /^%PDF/);
    assert.equal(data.bytes, readFileSync(p).length);
    // A letter is correspondence. Written with the process umask it lands
    // -rw-r--r-- on a normal account: every local user can read the post.
    assert.equal(statSync(p).mode & 0o777, 0o600, `saved as ${(statSync(p).mode & 0o777).toString(8)}`);
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
