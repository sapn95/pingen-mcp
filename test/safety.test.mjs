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
//
// The miss case complains on stderr exactly as the real tool does. It used to
// fail silently, which made the "not noise on stderr" assertion below unable to
// fail: the real `security` prints SecKeychainSearchCopyNext for every entry it
// cannot find, execFileSync hands that straight to our own stderr, and a server
// with two of three entries in the keychain therefore greeted its client with
// an error on every start while the suite stayed green.
const MISS = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
function keychainShim({ empty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pingen-shim-'));
  const log = join(dir, 'security.log');
  // `security find-generic-password -a pingen -s <service> -w` → $5 is the service.
  writeFileSync(join(dir, 'security'), `#!/bin/sh
echo "$5" >> "${log}"
${empty ? `echo '${MISS}' >&2; exit 44` : `case "$5" in
  pingen-mcp-client-id) echo '${FAKE.PINGEN_CLIENT_ID}' ;;
  pingen-mcp-client-secret) echo '${FAKE.PINGEN_CLIENT_SECRET}' ;;
  pingen-mcp-org-uuid) echo '${FAKE.PINGEN_ORG_UUID}' ;;
  *) echo '${MISS}' >&2; exit 44 ;;
esac`}
`, { mode: 0o755 });
  // The shim goes first on PATH so the real /usr/bin/security is never reached.
  return { path: `${dir}:${process.env.PATH}`, asked: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

// Puts the mock back to answering for itself after a test has had it hang up
// mid-call or hide behind a gateway. Kept as a function and called from a
// `finally`, so a failed assertion cannot leave every later test in the file
// talking to a server that drops the line — and so the flip back, which happens
// after an await, is not read as racing with the counters the same test took
// off the mock beforehand. The suite runs one call at a time.
// The status goes back too, and from in here rather than from the test that
// changed it, for the same reason the rest of it does: written out at the call
// site it is an assignment made after an await, which is exactly the shape that
// cannot be shown to be safe from the outside.
const answersAgain = () => { mock.state.dropAnswer = null; mock.state.gatewayAfter = null; mock.state.gatewayStatus = 502; };

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

  test('a confirmed submission without a product mails nothing', async () => {
    // required: in a schema is a hint to the client, not a check. Without a
    // product Pingen franks the letter however it likes — and it is in the post.
    const before = mock.state.submitted.length;
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', confirm: true });
    assert.match(data.refused, /delivery_product/);
    assert.equal(mock.state.submitted.length, before);
  });

  test('a refusal costs nothing: no token, no organisation lookup, no request', async () => {
    // The dispatcher resolved an organisation for every call before it reached
    // the branch that would refuse it, so declining to mail a letter still
    // minted a token and asked the API who we are. That ordering is also what
    // decides whether the smoke test can tell a deleted dispatcher branch from
    // a working one, so it is pinned here rather than left to the shape of the
    // code. PINGEN_ORG_UUID is blanked deliberately: with one configured there
    // is no lookup to make and the ordering cannot be observed.
    const fresh = await start();
    const s = await startServer({ PINGEN_API_BASE: fresh.base, PINGEN_ORG_UUID: '' });
    const { data } = await s.call('pingen_submit_letter', { letter_id: 'ltr-1', delivery_product: 'fast' });
    // Shut down before asserting: a failed assertion here would otherwise leave
    // the server running, and the runner then hangs on the live child instead
    // of printing which assertion went wrong.
    const calls = [...fresh.state.calls];
    await s.stop();
    await fresh.close();
    assert.match(data.refused, /confirm:true/);
    assert.equal(calls.length, 0, `it called out anyway: ${calls}`);
  });

  test('an unanswerable "which organisation" refuses before the PDF leaves the machine', async () => {
    // The refusal exists so that no letter is franked at an account nobody
    // chose. Resolving the organisation lazily at the POST meant the bytes were
    // already in Pingen's storage by the time the question was asked: a private
    // letter uploaded to an account the server had just declined to pick.
    const two = await start();
    two.state.orgs = [
      { id: 'org-a', type: 'organisations', attributes: { name: 'Example One' } },
      { id: 'org-b', type: 'organisations', attributes: { name: 'Example Two' } },
    ];
    const s = await startServer({ PINGEN_API_BASE: two.base, PINGEN_ORG_UUID: '' });
    const { raw, isError } = await s.call('pingen_send_letter', { file_path: pdf });
    const uploads = two.state.uploads.length;
    const calls = [...two.state.calls];
    await s.stop();
    await two.close();
    assert.ok(isError);
    assert.match(raw, /PINGEN_ORG_UUID/);
    assert.equal(uploads, 0, `the letter was uploaded anyway: ${calls}`);
    assert.ok(!calls.includes('GET /file-upload'), `it asked for an upload slot first: ${calls}`);
  });

  test('one organisation on a page that is not the whole list is still not one organisation', async () => {
    // The test above hands over both accounts and gets the refusal it should.
    // This is the shape that does not: the page holds exactly one, and there is
    // a second the answer only points at. Read by what is on the page, that is
    // an account nobody chose being picked automatically, and the letter is
    // franked at it. The tool already reads the pointer — but the fixture used
    // to send the link and the total together on a full page, so all three ways
    // of noticing agreed, and any one of them could be deleted without a sound.
    // Mutation testing is what said so. One signal at a time, on a short page:
    for (const signal of ['next', 'total']) {
      const many = await start();
      many.state.orgs = [
        { id: 'org-a', type: 'organisations', attributes: { name: 'Example One' } },
        { id: 'org-b', type: 'organisations', attributes: { name: 'Example Two' } },
      ];
      many.state.orgSignal = signal;
      many.state.orgPageCap = 1;
      const s = await startServer({ PINGEN_API_BASE: many.base, PINGEN_ORG_UUID: '' });
      const { raw, isError } = await s.call('pingen_send_letter', { file_path: pdf });
      const uploads = many.state.uploads.length;
      await s.stop();
      await many.close();
      assert.ok(isError, `${signal}: it picked the one it could see`);
      assert.match(raw, /PINGEN_ORG_UUID/, `${signal}: ${raw}`);
      assert.match(raw, /erste Seite/, `${signal}: never said the page was not the list: ${raw}`);
      assert.equal(uploads, 0, `${signal}: the letter went up anyway`);
    }
  });

  test('deleting without confirm removes nothing', async () => {
    const { data } = await srv.call('pingen_delete_letter', { letter_id: 'ltr-3' });
    assert.match(data.refused, /confirm:true/);
    assert.match(data.note, /pingen_cancel_letter/, 'it names the safe alternative');
    assert.ok(!mock.state.calls.some(c => c.startsWith('DELETE ')), 'nothing was deleted');
  });

  test('auto_send is reported from the status Pingen returned, not the flag we sent', async () => {
    // Pingen can accept the letter and still not send it. Repeating our own
    // request back as "wird versandt" is a wrong answer about the post.
    mock.state.nextStatus = 'action_required';
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    mock.state.nextStatus = null;
    assert.match(data.note, /NICHT versandt/, `claimed a send: ${data.note}`);
    assert.match(data.note, /action_required/);
  });

  test('a create that comes back in a non-draft state is not reported as a draft', async () => {
    // The note for the default path repeated the flag we sent: auto_send=false
    // was answered with "DRAFT erstellt (nichts versandt). Zum Senden:
    // pingen_submit_letter." whatever Pingen said had happened. That is the one
    // wrong answer here that costs money twice over — a letter Pingen has
    // already taken for printing, reported as still sitting there, with an
    // instruction to go and post it. The auto_send=true half of the same note
    // had been taught to read the status back a round earlier; this half had
    // not, and it is the half almost every call takes.
    mock.state.nextStatus = 'processing';
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
    mock.state.nextStatus = null;
    assert.equal(data.created.status, 'processing');
    assert.doesNotMatch(data.note, /nichts versandt/, `claimed nothing was mailed: ${data.note}`);
    assert.doesNotMatch(data.note, /Zum Senden/, `told the caller to post it a second time: ${data.note}`);
    assert.match(data.note, /processing/, 'and it says what Pingen actually reported');
  });

  test('a status nobody here has heard of is not reported as a send', async () => {
    // The status check was a denylist of three names, so every other answer —
    // including one that plainly is not a send — came out as "→ wird versandt".
    // What the tool knows is what Pingen told it, and about anything else it
    // has to say so rather than guess in the direction of "it went".
    mock.state.nextStatus = 'undeliverable';
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    mock.state.nextStatus = null;
    assert.doesNotMatch(data.note, /wird versandt/, `claimed a send off an unknown status: ${data.note}`);
    assert.match(data.note, /undeliverable/);
    assert.match(data.note, /pingen_get_letter/, 'and says where to go and look');
  });

  test('a status nobody here has heard of is not called "not a draft" either', async () => {
    // The auto_send=true half was split three ways and the auto_send=false half
    // was left with two, so everything that was not a resting state came back as
    // "das ist kein Entwurfszustand" — a positive claim about a status this code
    // has never seen. For an answer with no status at all it was the same
    // sentence the round before had been written to delete, only pointing the
    // other way: it does not know, and it says it knows.
    //
    // And the cost is the ordinary case, not the exotic one. Pingen adds one
    // pre-print state this version predates and every single draft creation
    // starts telling the caller not to submit — which is the whole flow of this
    // server, argued out of itself by a guess.
    for (const [how, set, unset] of [
      ['a status this version predates', () => { mock.state.nextStatus = 'pending'; }, () => { mock.state.nextStatus = null; }],
      ['no status at all', () => { mock.state.omitStatus = true; }, () => { mock.state.omitStatus = false; }],
    ]) {
      set();
      const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
      unset();
      assert.doesNotMatch(data.note, /kein Entwurfszustand/, `${how}: claimed to know it is not a draft: ${data.note}`);
      assert.match(data.note, /kennt dieser Server nicht/, `${how}: it did not say it does not know: ${data.note}`);
      assert.match(data.note, /pingen_get_letter/, `${how}: and it did not say where to look`);
    }
  });

  test('a draft Pingen has flagged is not announced as ready to send', async () => {
    // Four statuses shared one sentence. Two of them are Pingen saying it has
    // read the PDF and will not take it — the address was not in the window,
    // the franking zone is covered — and the README has a whole section about
    // that case, ending in "the letter can't be submitted". The note said
    // "DRAFT erstellt (nichts versandt). Zum Senden: pingen_submit_letter.":
    // this server telling the caller to post a letter it documents as
    // unpostable, in the one failure everybody hits. It was also the only one
    // of the six branches that never repeated what Pingen had answered, so the
    // sentence a reader reads said ready while the row above it said otherwise
    // — and what gets reported back to a human is "draft created, ready to
    // go", which is how a PDF nobody looked at again ends up believed correct.
    for (const st of ['action_required', 'invalid']) {
      mock.state.nextStatus = st;
      const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
      mock.state.nextStatus = null;
      assert.equal(data.created.status, st, 'the fixture did answer with it');
      assert.doesNotMatch(data.note, /Zum Senden: pingen_submit_letter/,
        `${st}: told the caller to post a letter Pingen had just refused: ${data.note}`);
      assert.match(data.note, new RegExp(st), `${st}: the note never said what Pingen answered: ${data.note}`);
      // It used to be pingen_get_letter that was named here, which is where a
      // reader is sent to learn nothing at all: see the test below.
      assert.match(data.note, /pingen_letter_events/, `${st}: and did not say where to look`);
      assert.equal(mock.state.submitted.length, 0, `${st}: something was submitted`);
    }
  });

  test('a draft Pingen is happy with still says to go ahead and send it', async () => {
    // The other half, and the one that must not become collateral: the whole
    // two-step flow of this server is "create a draft, then submit it". A
    // warning on every creation would be noise, and noise is how the real one
    // gets read past — the same reasoning that split the unknown branch off.
    for (const st of ['draft', 'valid']) {
      mock.state.nextStatus = st;
      const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
      mock.state.nextStatus = null;
      assert.equal(data.created.status, st);
      assert.match(data.note, /Zum Senden: pingen_submit_letter/, `${st}: the ordinary path stopped saying what to do next: ${data.note}`);
    }
  });

  test('the half that was told to mail it says so too when Pingen refuses', async () => {
    // Three places branch on RESTING, not two: this note has an auto_send=false
    // half and an auto_send=true half, and only the first was ever split. The
    // second answered a PDF Pingen will not print with "NICHT versandt.
    // Details: pingen_get_letter." — true as far as it goes, and silent about
    // the letter having been refused, which leaves the two obvious next moves
    // standing: submit it, or send the same PDF again. Both are exactly what
    // the sibling branches now warn against, and this is the half where the
    // caller has already said "put it in the post", so it is the half where the
    // urge to try again is strongest. Neither attempt is billed for, which is
    // how it survived three rounds of this: the letter that was meant to go out
    // simply never goes, and nothing on the bill says so.
    for (const st of ['action_required', 'invalid']) {
      mock.state.nextStatus = st;
      const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
      mock.state.nextStatus = null;
      assert.equal(data.created.status, st, 'the fixture did answer with it');
      assert.match(data.note, /NICHT versandt/, `${st}: stopped saying the letter did not go: ${data.note}`);
      assert.match(data.note, new RegExp(st), `${st}: the note never said what Pingen answered: ${data.note}`);
      assert.match(data.note, /korrigiertes PDF/, `${st}: never named the one thing that helps: ${data.note}`);
    }
  });

  test('a letter auto_send has simply not moved yet is not called a refusal', async () => {
    // The half that must not become collateral, the same way it was kept in the
    // other two places: draft and valid are Pingen holding a letter it has not
    // objected to, and answering those with "upload a corrected PDF" sends a
    // caller off to redo a letter that was fine.
    for (const st of ['draft', 'valid']) {
      mock.state.nextStatus = st;
      const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
      mock.state.nextStatus = null;
      assert.equal(data.created.status, st);
      assert.match(data.note, /NICHT versandt/, `${st}: stopped saying the letter did not go: ${data.note}`);
      assert.doesNotMatch(data.note, /korrigiertes PDF/, `${st}: sent the caller off to redo a letter Pingen never objected to: ${data.note}`);
    }
  });

  test('an answer carrying no status at all is not a send either', async () => {
    // The worst of the three: with no status in the answer the note read
    // `Status "unbekannt" → wird versandt`, which says in one breath that it
    // does not know and that the letter is on its way.
    mock.state.omitStatus = true;
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    mock.state.omitStatus = false;
    assert.equal(data.created.status, undefined, 'the fixture did answer without one');
    assert.doesNotMatch(data.note, /wird versandt/, `claimed a send off no status at all: ${data.note}`);
    assert.match(data.note, /pingen_get_letter/);
  });

  test('auto_send=true without a product mails nothing', async () => {
    // delivery_product is optional on this tool for exactly one reason: a draft
    // is franked later, by pingen_submit_letter, and that call was taught to
    // refuse without one because "required: in a schema is a hint, not a
    // check" — a letter franked however Pingen likes is in the post by the time
    // anyone looks. auto_send=true is the one route that never reaches that
    // call, so on it the product nobody chose was the product the letter went
    // out with, and the tool reported "wird versandt" over the top of it. The
    // gate on the second step has to guard the shortcut past it too.
    const before = {
      created: mock.state.created.length,
      slots: mock.state.calls.filter(c => c === 'GET /file-upload').length,
      uploads: mock.state.uploads.length,
    };
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf, auto_send: true });
    // The consequence before the wording: asserted the other way round, a
    // regression fails on `refused` being undefined, which reads like a broken
    // test rather than a letter in the post with a product nobody chose.
    assert.equal(mock.state.created.length, before.created,
      `a letter was accepted for printing with no product chosen: ${JSON.stringify(mock.state.created.at(-1))}`);
    assert.equal(mock.state.calls.filter(c => c === 'GET /file-upload').length, before.slots, 'it asked for an upload slot first');
    assert.equal(mock.state.uploads.length, before.uploads, 'the PDF left the machine for it');
    assert.match(String(data.refused), /delivery_product/, `it named something else: ${JSON.stringify(data)}`);
  });

  test('a draft still needs no product, because submit will ask for one', async () => {
    // The other half, and the reason the check above is conditional: making
    // delivery_product mandatory outright would break the two-step flow, where
    // the product is chosen at pingen_submit_letter and the draft carries none.
    const { data } = await srv.call('pingen_send_letter', { file_path: pdf });
    assert.equal(data.created.status, 'draft');
    assert.equal(mock.state.created.at(-1).delivery_product, undefined, 'no product is invented for a draft');
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

  test('a submission Pingen did not act on is not reported as a send', async () => {
    // The same defect that was taken out of pingen_send_letter's note twice
    // over, left standing in the tool that actually prints and posts:
    // "submitted" was concluded from the PATCH coming back 2xx, not from the
    // status that came back with it. Pingen can accept this call and leave the
    // letter exactly where it was — a draft whose address it cannot read
    // answers 200, status action_required — and the result then reads as a
    // receipt for a letter that is not going anywhere. Nobody checks, because
    // the tool said it was posted, and the bill is never sent.
    mock.state.sendStatus = 'action_required';
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    mock.state.sendStatus = null;
    assert.match(data.note, /NICHT unterwegs/, `claimed a send Pingen did not make: ${JSON.stringify(data)}`);
    assert.match(data.note, /action_required/, 'and it says what Pingen actually reported');
  });

  test('a send status nobody here has heard of is not reported as a send', async () => {
    mock.state.sendStatus = 'quarantined';
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    mock.state.sendStatus = null;
    assert.doesNotMatch(data.note, /geht raus/, `guessed in the direction of "it went": ${JSON.stringify(data)}`);
    assert.match(data.note, /quarantined/);
    assert.match(data.note, /pingen_get_letter/, 'and says where to go and look');
  });

  test('a send answer carrying no status is not reported as a send either', async () => {
    mock.state.omitSendStatus = true;
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    mock.state.omitSendStatus = false;
    assert.equal(data.letter.status, undefined, 'the fixture did answer without one');
    assert.doesNotMatch(data.note, /geht raus/, `claimed a send off no status at all: ${JSON.stringify(data)}`);
    assert.match(data.note, /pingen_get_letter/);
  });

  test('a letter Pingen did not take does not come back under a receipt', async () => {
    // The note was taught to read the status back and the key beside it was
    // not — although the key is exactly what the diagnosis had named: the
    // answer came back "under a key that reads as a receipt", and it still
    // did. {"submitted": {…}} with a note underneath saying NICHT unterwegs is
    // the same one-breath contradiction this pair of tools has been taken
    // apart for three rounds running, and of the two halves the key is the one
    // a skim keeps. A model reporting "letter submitted" off it is right about
    // the field name and wrong about the post, in the direction where nobody
    // ever goes looking, because there is no bill and no tracking number to
    // miss.
    for (const [how, set, unset] of [
      ['left in action_required', () => { mock.state.sendStatus = 'action_required'; }, () => { mock.state.sendStatus = null; }],
      ['answered with a status nobody here knows', () => { mock.state.sendStatus = 'quarantined'; }, () => { mock.state.sendStatus = null; }],
      ['answered with no status at all', () => { mock.state.omitSendStatus = true; }, () => { mock.state.omitSendStatus = false; }],
    ]) {
      set();
      const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
      unset();
      assert.equal(data.submitted, undefined, `${how}: filed under a receipt anyway: ${JSON.stringify(data)}`);
      assert.equal(data.letter.id, 'ltr-2', `${how}: and then did not hand the letter over at all: ${JSON.stringify(data)}`);
    }
  });

  test('a refused letter is not answered with "send it again"', async () => {
    // Last round split the create note so that action_required and invalid stop
    // being called ready to post, and gave the reason: Pingen has read the PDF
    // and will not take it, so telling the caller to submit is telling them to
    // do the one thing the README says cannot be done. The other place that
    // branches on the same list never got the same split. Its resting note ends
    // "Ursache prüfen: pingen_get_letter, danach erneut senden.", which for
    // draft and valid is exactly right and for these two is the identical wrong
    // advice under a different verb — and it is now advice that contradicts
    // what the sibling tool says about the very same status, so whichever of
    // the two a reader saw last decides whether they fix the PDF or retry in a
    // circle. Nothing here is billed for, which is why it survives: a refused
    // submit costs an API call, and the letter that was supposed to go out
    // simply never does.
    for (const st of ['action_required', 'invalid']) {
      mock.state.sendStatus = st;
      const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
      mock.state.sendStatus = null;
      assert.equal(data.letter.status, st, 'the fixture did answer with it');
      // Case-insensitive on purpose: the first draft of the fix said "Erneut
      // senden ändert daran nichts", which is the right meaning and would have
      // walked straight through a case-sensitive assertion on the strength of
      // one capital letter. A test that can be satisfied by shift is not a test.
      assert.doesNotMatch(data.note, /erneut senden/i,
        `${st}: told the caller to submit a letter Pingen had just refused: ${data.note}`);
      assert.match(data.note, new RegExp(st), `${st}: the note never said what Pingen answered: ${data.note}`);
      assert.match(data.note, /korrigiertes PDF/, `${st}: and never named the one thing that helps: ${data.note}`);
    }
  });

  test('a letter that is merely still sitting there is still worth retrying', async () => {
    // The half that must not become collateral, and the reason the split is a
    // split rather than a rewrite: draft and valid are Pingen holding a letter
    // it has not refused, and for those "check why, then send again" is the
    // correct next step. Turning every resting answer into "upload a new PDF"
    // would send a caller off to redo work over a letter that was fine.
    for (const st of ['draft', 'valid']) {
      mock.state.sendStatus = st;
      const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
      mock.state.sendStatus = null;
      assert.equal(data.letter.status, st);
      assert.match(data.note, /erneut senden/i, `${st}: stopped saying what to do next: ${data.note}`);
      assert.doesNotMatch(data.note, /korrigiertes PDF/, `${st}: sent the caller off to redo a letter Pingen never objected to: ${data.note}`);
    }
  });

  test('a refused letter is told where the reason actually is', async () => {
    // Every one of the three notes above ends by telling the reader to go and
    // find out why, and every one of them used to send them to
    // pingen_get_letter. That tool answers with letterRow and nothing else —
    // id, status, delivery_product, recipient, tracking, pages, submitted,
    // price — so whatever Pingen puts on the letter about the refusal, what
    // comes back is the status the note has just quoted and not one word more.
    // The reason is on the tracking trail, as a bare string, and
    // pingen_letter_events has been handing it over as `detail` all along. So
    // the note raised the one question that matters and pointed at the one tool
    // in this server that structurally cannot answer it, and what reaches a
    // human is "this letter needs action" with no way to learn what action —
    // which is where a letter stops, because the next step is unknowable and
    // nothing costs anything to leave undone.
    //
    // The same shape as "limit erhöhen (max 100)" told to a caller already at
    // 100: advice that cannot be followed is followed once and then abandoned.
    const trail = mock.state.eventTrail;
    // Shaped like the real thing rather than like a test string: Pingen puts the
    // refusal on the trail as a bare code in `data`, not as prose and not as a
    // field on the letter. If that ever becomes an object the assertion below
    // still holds, because it asks whether the answer contains the code at all.
    const reason = 'layout_unsupported_format';
    mock.state.eventTrail = [
      ...trail,
      { id: 'ev-refused', type: 'letter_events', attributes: { type: 'letter.validation_failed', emitted_at: '2026-07-01T09:45:00+00:00', data: reason } },
    ];
    try {
      const refused = [];
      for (const st of ['action_required', 'invalid']) {
        mock.state.nextStatus = st;
        const draft = await srv.call('pingen_send_letter', { file_path: pdf });
        const auto = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
        mock.state.nextStatus = null;
        mock.state.sendStatus = st;
        const sent = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
        mock.state.sendStatus = null;
        refused.push([`${st} on a draft`, draft.data.note, draft.data.created.id],
          [`${st} on auto_send`, auto.data.note, auto.data.created.id],
          [`${st} on submit`, sent.data.note, 'ltr-2']);
      }
      for (const [how, note, id] of refused) {
        assert.match(note, /pingen_letter_events/, `${how}: never said where the reason is: ${note}`);
        assert.doesNotMatch(note, /pingen_get_letter/, `${how}: sent the reader to the tool that cannot say why: ${note}`);
        // And the tool it names does answer the question, which is the half
        // that makes the other half worth asserting: a note may only send a
        // caller somewhere the answer actually is.
        const { raw } = await srv.call('pingen_letter_events', { letter_id: id });
        assert.ok(raw.includes(reason), `${how}: the tool the note names had nothing to say either: ${raw}`);
      }
    } finally {
      mock.state.eventTrail = trail;
    }
  });

  test('a submission Pingen did take is reported as one', async () => {
    // The half that must keep working: an answer that says the letter has been
    // taken for printing has to read as a send, or the note becomes noise and
    // noise is how a real warning gets read past.
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    assert.equal(data.submitted.status, 'processing', `the earned receipt went missing: ${JSON.stringify(data)}`);
    assert.match(data.note, /geht raus/, `a genuine send was hedged: ${JSON.stringify(data)}`);
  });

  test('a submit whose answer never came back is not reported as a letter that stayed put', async () => {
    // Everything above this line is about reading an answer correctly: the two
    // status lists, the three notes, the key the row is filed under. None of it
    // covers the call that gets no answer at all, and that is the one that
    // costs. The PATCH reaches Pingen, Pingen takes the letter for printing,
    // and the connection dies before a byte of the reply arrives — a timeout, a
    // proxy giving up, a socket dropped mid-body all land here. What the tool
    // handed over was "PATCH …/send: fetch failed", which reads exactly like a
    // call that never got there, and the obvious next move after a call that
    // never got there is to make it again. That is the second letter: printed,
    // franked, posted, charged, no undo — arrived at through the only path with
    // no status to branch on.
    const before = mock.state.submitted.length;
    mock.state.dropAnswer = 'send';
    // Restored in a finally: a failed assertion below would otherwise leave the
    // mock answering nothing to every later test in the file.
    let out;
    try {
      out = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    } finally {
      answersAgain();
    }
    const { raw, isError } = out;
    // The premise first: this is not a call that failed to arrive. Asserted the
    // other way round, a regression reads like a broken fixture rather than a
    // letter in the post that nobody was told about.
    assert.equal(mock.state.submitted.length, before + 1, 'the fixture did take the letter for printing');
    assert.ok(isError, 'the call did fail');
    assert.match(raw, /pingen_get_letter/, `never named the tool that can settle it: ${raw}`);
    assert.match(raw, /zweimal raus/, `left "send it again" looking like the obvious next move: ${raw}`);
  });

  test('a create that mails and never answers says the letter may exist anyway', async () => {
    // The same silence on the shortcut, and worse there: a retry does not
    // collide with anything, it uploads the same PDF again and creates a second
    // letter that Pingen mails on its own. The id that would let anyone check
    // is in the answer that went missing, so the note has to name the tool that
    // works without one.
    const before = mock.state.created.length;
    mock.state.dropAnswer = 'create';
    let out;
    try {
      out = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    } finally {
      answersAgain();
    }
    const { raw, isError } = out;
    assert.equal(mock.state.created.length, before + 1, 'the fixture did create it with auto_send');
    assert.equal(mock.state.created.at(-1).auto_send, true, 'and it was the mailing half');
    assert.ok(isError);
    assert.match(raw, /pingen_list_letters/, `never named a way to check without an id: ${raw}`);
    assert.match(raw, /zweimal raus/, `left uploading the same PDF again looking harmless: ${raw}`);
  });

  test('a failure Pingen did describe is not dressed up as a maybe-posted letter', async () => {
    // The other half, and the reason this is not simply glued onto every error:
    // a failure that came back with a status carries Pingen's own account of
    // what happened — 404 says the letter is not there, so nothing was printed
    // and nothing needs checking. A warning on those is noise, and noise is how
    // the real one gets read past. The draft half of the create is here for the
    // same reason: it is the most common call in the server, nothing it does
    // reaches the post, and a lost answer there costs an orphan draft.
    const answered = await srv.call('pingen_submit_letter', { letter_id: 'no-such-letter', delivery_product: 'fast', confirm: true });
    assert.ok(answered.isError);
    assert.match(answered.raw, /404/, `the fixture did answer with a status: ${answered.raw}`);
    assert.doesNotMatch(answered.raw, /zweimal raus/, `cried wolf over a letter Pingen never had: ${answered.raw}`);

    mock.state.dropAnswer = 'create';
    let draft;
    try {
      draft = await srv.call('pingen_send_letter', { file_path: pdf });
    } finally {
      answersAgain();
    }
    assert.ok(draft.isError);
    assert.doesNotMatch(draft.raw, /zweimal raus/, `warned about the post over a draft: ${draft.raw}`);
  });

  test('a gateway status over a letter Pingen already took is not read as a send that failed', async () => {
    // "A failure that came back with a status is a failure Pingen described" is
    // true of the statuses Pingen writes and false of the ones it does not. A
    // 502 is written by whatever sits in front of the API — a gateway, a proxy,
    // a load balancer — and it means one thing only: "I forwarded this and
    // could not get an answer back". The origin took the letter for printing on
    // the far side of that sentence just as easily as it did nothing at all, so
    // reading it as an account of what happened is the same guess the round
    // before was spent removing, arrived at through a status instead of through
    // silence. And it is the guess in the expensive direction: a bare
    // "PATCH …/send → 502" reads as a call that failed, and the next move after
    // a call that failed is to make it again.
    const before = mock.state.submitted.length;
    mock.state.gatewayAfter = 'send';
    let out;
    try {
      out = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    } finally {
      answersAgain();
    }
    const { raw, isError } = out;
    // The premise, asserted first for the same reason as above: a regression
    // here has to read as a letter in the post nobody was told about, not as a
    // broken fixture.
    assert.equal(mock.state.submitted.length, before + 1, 'the fixture did take the letter for printing');
    assert.ok(isError, 'the call did fail');
    assert.match(raw, /502/, 'the status is still reported');
    assert.match(raw, /pingen_get_letter/, `never named the tool that can settle it: ${raw}`);
    assert.match(raw, /zweimal raus/, `a gateway's patience was read as Pingen's answer: ${raw}`);
  });

  test('a gateway status over an auto_send create says the letter may exist anyway', async () => {
    // The same status on the other call that mails, where it is worse for the
    // same reason silence is: the retry collides with nothing, it uploads the
    // PDF again and Pingen mails the second letter on its own.
    const before = mock.state.created.length;
    mock.state.gatewayAfter = 'create';
    mock.state.gatewayStatus = 504;
    let out;
    try {
      out = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
    } finally {
      answersAgain();
    }
    const { raw, isError } = out;
    assert.equal(mock.state.created.length, before + 1, 'the fixture did create it');
    assert.equal(mock.state.created.at(-1).auto_send, true, 'and it was the mailing half');
    assert.ok(isError);
    assert.match(raw, /pingen_list_letters/, `never named a way to check without an id: ${raw}`);
    assert.match(raw, /zweimal raus/, `a gateway's patience was read as Pingen's answer: ${raw}`);
  });

  test('the line between an answer and a silence is drawn at exactly 500', async () => {
    // Everything above uses 502 or 504, which sit comfortably on one side of a
    // boundary nothing had ever stood on. Mutation testing pointed that out:
    // widening the test to `<= 500` left the whole suite green, and what that
    // mutant does is mark a 500 as answered — which removes the warning from
    // the one status most likely to mean the handler died holding the letter.
    // 500 is the first status where nothing is known, so it gets the warning;
    // 499 is still someone refusing, so it does not.
    for (const [status, warned] of [[500, true], [499, false]]) {
      mock.state.gatewayAfter = 'create';
      mock.state.gatewayStatus = status;
      let out;
      try {
        out = await srv.call('pingen_send_letter', { file_path: pdf, delivery_product: 'fast', auto_send: true });
      } finally {
        answersAgain();
      }
      assert.ok(out.isError, `${status} should still be an error`);
      if (warned) assert.match(out.raw, /trotzdem raus/, `${status} tells nobody the letter may exist: ${out.raw}`);
      else assert.doesNotMatch(out.raw, /trotzdem raus/, `${status} was answered, and got the warning anyway: ${out.raw}`);
    }
  });

  test('a submit that never sent a request is not reported as a maybe-posted letter', async () => {
    // The mirror image, and the reason the warning has to stay rare to stay
    // worth reading. It fired on any error carrying no status, and a failure
    // this process reaches on its own carries none either: a missing client
    // secret, a grant the token endpoint refused, a base that is set but empty.
    // Nothing has left the machine in any of those, and the most ordinary of
    // them — no credentials configured — came back with a paragraph about a
    // letter that might be printing and an instruction to go and check. Told
    // that on their first run, the reader learns the paragraph means nothing,
    // and it is the same paragraph that has to be believed on the day a
    // connection really does die mid-send.
    const quiet = await start();
    const s = await startServer({ PINGEN_API_BASE: quiet.base, PINGEN_CLIENT_SECRET: '' });
    const { raw, isError } = await s.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    const calls = [...quiet.state.calls];
    await s.stop();
    await quiet.close();
    assert.ok(isError);
    assert.equal(calls.length, 0, `the premise: it never called out at all, but did: ${calls}`);
    assert.match(raw, /Keine Pingen-Credentials/, `the actual fault is still what the message says: ${raw}`);
    assert.doesNotMatch(raw, /trotzdem raus/, `cried wolf over a request that was never sent: ${raw}`);
    assert.doesNotMatch(raw, /zweimal raus/, `and told the reader not to retry a call that never happened: ${raw}`);
  });

  test('a token revoked mid-session costs one retry, not a second letter', async () => {
    // The 401 path re-grants and replays the request, and it replays mutations
    // too — the reasoning being that a 401 is refused by the authorisation
    // layer before the handler ever sees it, so nothing happened the first
    // time. That reasoning had never once been executed: the mock honoured
    // every token it had ever issued, so in thirteen rounds the branch that
    // re-sends a PATCH .../send was never taken, and "it replays a mutation
    // safely" was an assertion about code nothing had run. What it must not do
    // is print the letter twice.
    const m = await start();
    m.state.rotateTokens = true;
    const s = await startServer({ PINGEN_API_BASE: m.base });
    await s.call('pingen_list_letters');            // mints the bearer that is about to die
    m.state.revokedTokens.push(m.state.issuedTokens[0]);
    const { data, isError } = await s.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    const sends = m.state.calls.filter(c => c.endsWith('/send')).length;
    const submitted = m.state.submitted.length;
    const grants = m.state.issuedTokens.length;
    await s.stop();
    await m.close();
    assert.ok(!isError, `a revoked token cost the whole call: ${JSON.stringify(data)}`);
    assert.equal(grants, 2, 'exactly one fresh grant, not one per attempt');
    assert.equal(sends, 2, 'the refused attempt and the replay — and no third');
    assert.equal(submitted, 1, 'the letter was accepted for printing exactly once');
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

  test('a token the process has replaced is still redacted', async () => {
    // The redactor masked whatever the token variable held at the moment the
    // error came back, which is not the same thing as the token the failing
    // request was sent with. Two tool calls are all it takes: the second one
    // re-grants — after a 401, or simply because the first token was near
    // expiry — while the first is still in flight, and this API answers a 500
    // by quoting the Authorization header it was given. The bearer that came
    // back was then one the redactor had never heard of, and it went into the
    // tool result verbatim while it was still valid.
    const m = await start();
    m.state.rotateTokens = true;
    m.state.tokenTtl = 1;                  // near expiry on arrival: every call re-grants
    let release;
    m.state.holdLeak = new Promise(r => { release = r; });
    const s = await startServer({ PINGEN_API_BASE: m.base });
    const slow = s.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    // Released before it has even reached the mock there is only ever one
    // token, and the test would pass against the bug it is written for.
    const deadline = Date.now() + 10000;
    while (!m.state.calls.some(c => c.endsWith('/ltr-leak')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    await s.call('pingen_get_letter', { letter_id: 'ltr-1' });
    release();
    const { raw, isError } = await slow;
    const [stale] = m.state.issuedTokens;
    const grants = m.state.issuedTokens.length;
    await s.stop();
    await m.close();
    assert.ok(grants >= 2, `the fixture never rotated the token (${grants} grant(s))`);
    assert.ok(isError, 'the failure is still reported');
    assert.ok(!raw.includes(stale), `a bearer this process issued reached a tool result: ${raw}`);
    assert.match(raw, /\*\*\*/, 'it is masked, not merely absent');
  });

  test('a bearer is not forgotten while its own request is still travelling', async () => {
    // The set of bearers the redactor knows about was bounded by a plain count
    // of eight, on the reasoning that no more than that could be minted while a
    // request was still out. Eight ordinary tool calls do it: each of them
    // re-grants, because the token it was handed came back near expiry, and the
    // eighth pushes the bearer that the slow request is still travelling with
    // off the end of the set. That bearer is precisely the one the answer to
    // that request quotes back, so the token the redactor most needed was the
    // first one it dropped — and it reached the tool result while it was still
    // valid. How many grants happen during a request has nothing to do with how
    // long the request takes, which is why a count could never hold that line.
    const m = await start();
    m.state.rotateTokens = true;
    m.state.tokenTtl = 1;                  // near expiry on arrival: every call re-grants
    let release;
    m.state.holdLeak = new Promise(r => { release = r; });
    const s = await startServer({ PINGEN_API_BASE: m.base });
    const slow = s.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    const deadline = Date.now() + 10000;
    while (!m.state.calls.some(c => c.endsWith('/ltr-leak')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    // A dozen where eight was already enough: what the test is about is "more
    // grants than the set will hold", and the margin keeps it meaningful if
    // that number is ever nudged upwards.
    for (let i = 0; i < 12; i++) await s.call('pingen_get_letter', { letter_id: 'ltr-1' });
    release();
    const { raw, isError } = await slow;
    const [stale] = m.state.issuedTokens;
    const grants = m.state.issuedTokens.length;
    await s.stop();
    await m.close();
    assert.ok(grants > 8, `the fixture never got past the bound (${grants} grant(s))`);
    assert.ok(isError, 'the failure is still reported');
    assert.ok(!raw.includes(stale), `a bearer its own request was still out with reached a tool result: ${raw}`);
    assert.match(raw, /\*\*\*/, 'it is masked, not merely absent');
  });

  test('a bearer nothing is travelling with is eventually let go, and one that is is not', async () => {
    // The other half of the bound, and the half nothing had ever looked at:
    // emptying forgetSpent entirely, or releaseToken with it, left every test
    // green. Of course it did — everything above asks whether a bearer is
    // still masked, and a set that never forgets masks everything. What the
    // forgetting is for is that the set does not grow once per 401 for the
    // life of the process, and every string that leaves here is walked over
    // for each entry in it.
    //
    // It is deliberately a trade: a bearer that is dead, superseded and out of
    // flight stops being masked, because quoting a token nothing will accept
    // costs nothing. Written down here so that the day someone makes the set
    // unbounded to close a "leak", this says what was given up for what.
    const m = await start();
    m.state.rotateTokens = true;
    m.state.tokenTtl = 1;                  // near expiry on arrival: every call re-grants
    const s = await startServer({ PINGEN_API_BASE: m.base });
    for (let i = 0; i < 12; i++) await s.call('pingen_get_letter', { letter_id: 'ltr-1' });
    const issued = [...m.state.issuedTokens];

    m.state.echoToken = `Bearer ${issued[0]}`;          // long since released, and past the bound
    const old = await s.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    m.state.echoToken = `Bearer ${issued.at(-1)}`;      // the one still in the variable
    const live = await s.call('pingen_get_letter', { letter_id: 'ltr-leak' });
    await s.stop();
    await m.close();

    assert.ok(issued.length > 8, `the fixture never got past the bound (${issued.length} grant(s))`);
    assert.ok(!live.raw.includes(issued.at(-1)), `the live bearer reached a tool result: ${live.raw}`);
    assert.ok(old.raw.includes(issued[0]),
      'the first of twelve bearers is still held: the set is not being trimmed, and grows once per grant for the life of the process');
  });

  test('a bearer is still known to the redactor when its own result is built', async () => {
    // The pin lasted exactly as long as the HTTP request, under a note that
    // said it lasted "until its answer has been turned into a result or a
    // message — which is where redact() runs". It does not: redact() runs in
    // the dispatcher, after api() has returned. For a failed request the gap is
    // harmless, because the body is excerpted inside api() while the bearer is
    // still pinned — which is why the loud-failure letter could never have
    // shown this. A 200 is redacted on the way out instead, and by then the
    // bearer had been released.
    //
    // Nine ordinary reads in flight at once is all it takes: nine is one more
    // than the set will hold, so the moment the first one lets go of its bearer
    // that bearer is the oldest forgettable thing in the set — dropped, while
    // its own answer was still being turned into the result that quotes it.
    const m = await start();
    m.state.rotateTokens = true;
    m.state.tokenTtl = 1;                  // near expiry on arrival: every call re-grants
    let release;
    m.state.holdEcho = new Promise(r => { release = r; });
    const s = await startServer({ PINGEN_API_BASE: m.base });
    // Started one at a time, so each call has finished granting before the next
    // asks: fired together they would share one bearer and prove nothing.
    const inflight = [];
    for (let i = 1; i <= 9; i++) {
      inflight.push(s.call('pingen_get_letter', { letter_id: `ltr-echo-${i}` }));
      const deadline = Date.now() + 10000;
      while (!m.state.calls.some(c => c.endsWith(`/ltr-echo-${i}`)) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5));
      }
    }
    const [first] = m.state.issuedTokens;
    release();
    const results = await Promise.all(inflight);
    const grants = m.state.issuedTokens.length;
    await s.stop();
    await m.close();
    assert.ok(grants >= 9, `the fixture never got past the bound (${grants} grant(s))`);
    const blob = results.map(r => r.raw).join('\n');
    assert.ok(!blob.includes(first), `a bearer reached a tool result while its own call was being answered: ${blob}`);
    assert.match(results[0].raw, /Bearer \*\*\*/, 'it is masked, not merely absent');
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
