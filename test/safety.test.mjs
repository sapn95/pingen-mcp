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
      assert.match(data.note, /pingen_get_letter/, `${st}: and did not say where to look`);
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

  test('a submission Pingen did take is reported as one', async () => {
    // The half that must keep working: an answer that says the letter has been
    // taken for printing has to read as a send, or the note becomes noise and
    // noise is how a real warning gets read past.
    const { data } = await srv.call('pingen_submit_letter', { letter_id: 'ltr-2', delivery_product: 'fast', confirm: true });
    assert.equal(data.submitted.status, 'processing', `the earned receipt went missing: ${JSON.stringify(data)}`);
    assert.match(data.note, /geht raus/, `a genuine send was hedged: ${JSON.stringify(data)}`);
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
