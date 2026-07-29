#!/usr/bin/env node
// pingen-mcp — MCP server for Pingen v2 (https://pingen.com): send physical
// letters (A-Post / B-Post / registered / Einschreiben) from a PDF via the
// Pingen REST API, and track their status.
//
// Auth: OAuth2 client_credentials against the API host — the same
// host from the API itself. Credentials are read from env or, on macOS, from
// the login keychain (service names pingen-mcp-client-id / -client-secret /
// -org-uuid). NEVER commit credentials.
//
// Safety: send_letter creates a DRAFT (auto_send=false) unless the caller
// explicitly passes auto_send:true. Short of that one opt-in, nothing is
// physically mailed until submit_letter is called — and that call, like
// delete_letter, needs confirm:true. Posting a letter spends money and reaches
// the physical world; deleting a draft cannot be undone. Cancelling is the one
// direction that is safe, so pingen_cancel_letter stays ungated.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, statSync, openSync, writeSync, fchmodSync, closeSync, constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// stdio is spelled out because execFileSync hands the child's stderr straight to
// ours by default, and `security` writes a line to stderr for every entry it
// cannot find. A machine that keeps only the two required credentials in the
// keychain therefore printed "SecKeychainSearchCopyNext: The specified item
// could not be found" on a perfectly healthy start, which a client shows as a
// server error and which the catch below was written to swallow. The exit code
// is all we ever wanted from it.
function keychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'pingen', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// A variable that is *set* wins, even when it is empty. Written as
// `process.env.X || keychain(...)` an empty variable falls through to the login
// keychain, so a test run or a container that deliberately blanks a credential
// silently authenticates as the real account instead of failing.
const envOrKeychain = (name, service) =>
  (process.env[name] !== undefined ? process.env[name] : keychain(service)).trim();

// The token endpoint lives on the SAME host as the resources for this account:
// POST {API}/auth/access-tokens, verified live. The official SDK mints tokens on
// identity.pingen.com instead, and following it here broke authentication
// outright — the split is real for some Pingen setups but not for this one.
// PINGEN_AUTH_BASE exists to point somewhere else when that is genuinely needed,
// and for tests; it defaults to the API host because that is what works.
//
// Same set-wins rule as above for both: a blank base must not quietly resolve
// to production. It stays blank and every call fails loudly.
function base(name, fallback) {
  let b = (process.env[name] ?? fallback).trim();
  while (b.endsWith('/')) b = b.slice(0, -1);
  return b;
}
const API = base('PINGEN_API_BASE', 'https://api.pingen.com');
const AUTH = base('PINGEN_AUTH_BASE', API);
// Which variable actually determined the auth host — so an error names the one
// the reader has to change, not the one that merely exists.
const AUTH_VAR = process.env.PINGEN_AUTH_BASE !== undefined ? 'PINGEN_AUTH_BASE' : 'PINGEN_API_BASE';
const target = (b, name, path) => {
  if (!b) throw new Error(`${name} ist gesetzt, aber leer — kein Ziel für ${path}.`);
  return b + path;
};
const apiUrl = path => target(API, 'PINGEN_API_BASE', path);
const authUrl = path => target(AUTH, AUTH_VAR, path);

// Every request goes through here, so every request is bounded: a stalled
// endpoint fails the tool call instead of hanging the client for ever. 20s is
// what the official SDK allows; moving actual bytes gets longer.
const TIMEOUT_MS = 20000;
const TRANSFER_TIMEOUT_MS = 120000;
async function http(what, resource, { timeout = TIMEOUT_MS, ...init } = {}) {
  try {
    return await fetch(resource, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    // Keep the original as `cause`: the friendly message says what failed, the
    // cause still says why, which is what you need when debugging a network error.
    if (e?.name === 'TimeoutError') throw new Error(`${what}: Zeitüberschreitung nach ${timeout / 1000}s.`, { cause: e });
    throw new Error(`${what}: ${e?.message || String(e)}`, { cause: e });
  }
}

const CLIENT_ID = envOrKeychain('PINGEN_CLIENT_ID', 'pingen-mcp-client-id');
const CLIENT_SECRET = envOrKeychain('PINGEN_CLIENT_SECRET', 'pingen-mcp-client-secret');
let ORG = envOrKeychain('PINGEN_ORG_UUID', 'pingen-mcp-org-uuid');

let token = null, tokenExp = 0, pendingToken = null;

// Every bearer this process has held, not only the one it is holding now. The
// redactor used to read the live variable, so a token replaced between a
// request going out and its error coming back was no longer a token it knew
// about: two tool calls are enough, because the second one re-grants — after a
// 401, or simply because the first token was near expiry — while the first is
// still in flight, and this API answers a 500 by quoting the Authorization
// header it was given. The old bearer, still valid, went into the tool result
// verbatim.
//
// Bounded on purpose. An upstream that answers 401 to everything mints one
// token per call, and a set that only ever grows would cost memory and a pass
// over every string that leaves here.
//
// The bound used to be a plain count of eight, on the reasoning that no more
// than that could be minted while a request was still out. It can be: eight
// ordinary tool calls are enough, because each of them re-grants — after a 401,
// or because the token it was handed came back near expiry — and eight grants
// push the bearer of the request that is still travelling off the end of the
// set. That bearer is the one the answer to that very request quotes back, so
// the one token the redactor most needs was the first one it dropped, and it
// reached the tool result while it was still valid. A count could never have
// held that line: the number of grants during a request has nothing to do with
// how long the request takes.
//
// So what is still out is pinned, and only what is not can be forgotten. The
// set is bounded by eight plus however many requests are genuinely in flight,
// which is bounded by the client, and every bearer that can still come back
// quoted is in it.
const tokensHeld = new Set();
const tokensOut = new Map();
function rememberToken(t) { tokensHeld.add(t); forgetSpent(); }
function forgetSpent() {
  for (const t of tokensHeld) {
    if (tokensHeld.size <= 8) break;
    if (t === token || tokensOut.has(t)) continue;
    tokensHeld.delete(t);
  }
}
// Held from the moment a request is given a bearer until its answer has been
// turned into a result or a message — which is where redact() runs — and not a
// moment less.
function holdToken(t) { tokensOut.set(t, (tokensOut.get(t) ?? 0) + 1); }
function releaseToken(t) {
  const n = (tokensOut.get(t) ?? 0) - 1;
  if (n > 0) tokensOut.set(t, n); else tokensOut.delete(t);
  forgetSpent();
}

// A tool result is handed straight to the model, and an upstream error body can
// quote the request that produced it — Pingen's token endpoint does exactly
// that. Strip anything secret out of every string that leaves this process, in
// each form it could have travelled in: raw, JSON-escaped, percent-encoded.
function redact(s) {
  let out = String(s ?? '');
  for (const v of [CLIENT_SECRET, CLIENT_ID, ...tokensHeld]) {
    // Short values are left alone deliberately: a 4-character string is far
    // more likely to be ordinary text than a credential, and mangling every
    // occurrence of it would make errors unreadable. Real Pingen credentials
    // are long. Note this masks values we hold verbatim — an upstream that
    // echoes a credential in pieces or re-encoded some other way cannot be
    // caught by string matching, which is why the token endpoint's body is
    // never forwarded at all (see requestToken).
    if (typeof v !== 'string' || v.length < 8) continue;
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), encodeURIComponent(v).replaceAll('%20', '+')])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}
// Redact first, cut second: truncating a body mid-credential would leave a
// fragment no longer matching anything the redactor knows about.
const excerpt = (s, n) => redact(s).slice(0, n);

async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  // One grant at a time: parallel tool calls would otherwise each open their own.
  pendingToken ??= requestToken().finally(() => { pendingToken = null; });
  return pendingToken;
}
async function requestToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Keine Pingen-Credentials (env oder Keychain pingen-mcp-client-id/-secret).');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const r = await http('Token', authUrl('/auth/access-tokens'), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  // The body of a failed grant is the one response that is *made* of the
  // credentials we just sent, so only its status and the OAuth error code get
  // out — never the free-text detail.
  if (!r.ok) {
    const code = await r.json().then(j => j?.error, () => null);
    throw new Error(`Token-Fehler ${r.status}${code ? ` (${String(code).slice(0, 40)})` : ''} von ${AUTH}.`);
  }
  const j = await r.json();
  if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('Token-Antwort ohne access_token.');
  token = j.access_token; rememberToken(token); tokenExp = Date.now() + (Number(j.expires_in) || 43200) * 1000;
  return token;
}

// Ids go into a URL path, and a path is not a string: "x/../y" resolves away and
// "../../organisations/<other>/…" reaches a different account entirely. A
// confirmed delete or submit must act on the letter the caller named, so an id
// that is not one is refused rather than encoded and hoped for.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function letterId(v) {
  const id = String(v ?? '');
  if (!ID.test(id)) throw new Error(`Ungültige letter_id: ${JSON.stringify(id).slice(0, 60)}`);
  return id;
}

async function api(method, path, { json, raw, retry = true } = {}) {
  const bearer = await accessToken();
  const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.api+json' };
  let bodyInit;
  if (json !== undefined) { headers['Content-Type'] = 'application/vnd.api+json'; bodyInit = JSON.stringify(json); }
  // This is the bearer that can come back quoted, so it stays known to the
  // redactor for exactly as long as the request is out. The release is in a
  // finally and the masking is in the message that is thrown, so the error is
  // built while the token is still pinned.
  holdToken(bearer);
  try {
    const r = await http(`${method} ${path}`, apiUrl(path), { method, headers, body: bodyInit, timeout: raw ? TRANSFER_TIMEOUT_MS : TIMEOUT_MS });
    // A 401 means the request was refused before it did anything, so retrying it
    // once with a fresh token is safe even for a mutation — and it is the
    // difference between a revoked token costing one call and costing every call
    // until the process restarts.
    if (r.status === 401 && retry) {
      token = null; tokenExp = 0;
      // Awaited rather than handed back: `return promise` inside a try runs the
      // finally as soon as the promise exists, which would unpin this bearer
      // while the retry is still travelling with the next one.
      return await api(method, path, { json, raw, retry: false });
    }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${excerpt(await r.text(), 500)}`);
    if (raw) return r;
    const txt = await r.text();
    return txt ? JSON.parse(txt) : {};
  } finally {
    releaseToken(bearer);
  }
}

// Discovered once and remembered, and — like the token — looked up only once
// even if several tool calls arrive together.
let pendingOrg = null;
function orgId() {
  if (ORG) return Promise.resolve(ORG);
  pendingOrg ??= discoverOrg().finally(() => { pendingOrg = null; });
  return pendingOrg;
}
async function discoverOrg() {
  const d = await api('GET', '/organisations');
  const orgs = d.data || [];
  if (!orgs.length) throw new Error('Keine Organisation gefunden.');
  // Only auto-select when there is nothing to choose. With several, taking the
  // first one off a collection would decide — silently — which account pays for
  // and franks the letter.
  if (orgs.length > 1) {
    throw new Error(`${orgs.length} Organisationen — PINGEN_ORG_UUID setzen: ${orgs.map(o => `${o.id} (${o.attributes?.name})`).join(', ')}`);
  }
  ORG = orgs[0].id;
  return ORG;
}

// Upload a local PDF: GET /file-upload → PUT bytes → returns {url, signature}.
// The file is read and checked first, so a wrong path is refused before its
// bytes leave the machine rather than after Pingen has seen them.
// Write bytes to a path the caller named, and only to a path.
//
// writeFileSync takes a number as a FILE DESCRIPTOR, so output_path: 2 wrote a
// letter to stderr and output_path: 1 wrote it into the MCP stream itself. It
// also follows a symlink at the destination, and mode: only applies to a file
// it creates — an existing world-readable file kept its permissions until the
// chmod afterwards. O_NOFOLLOW and an explicit 0600 close all three.
function writePrivate(path, bytes) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`output_path muss ein Pfad sein, nicht ${typeof path}`);
  }
  // Relative means "relative to wherever the server was started", which the
  // caller does not know and the schema says is absolute. Guessing that wrong
  // writes a letter somewhere nobody will look for it.
  if (!isAbsolute(path)) throw new Error(`output_path muss absolut sein: ${path}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    // writeSync may write fewer bytes than it was given. Ignoring the return
    // value meant a truncated PDF was reported as saved, with the full byte
    // count beside it.
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (!n) throw new Error(`Schreiben blieb bei ${off}/${bytes.length} Bytes stehen`);
      off += n;
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

async function uploadFile(filePath) {
  // readFileSync takes a number as a file descriptor too: file_path: 0 reads
  // the MCP input stream, and a character device never ends.
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`file_path muss ein Pfad sein, nicht ${typeof filePath}`);
  }
  // Same reasoning as the output path, and here it decides which PDF is mailed.
  if (!isAbsolute(filePath)) throw new Error(`file_path muss absolut sein: ${filePath}`);
  const st = statSync(filePath);
  if (!st.isFile()) throw new Error(`file_path ist keine normale Datei: ${basename(String(filePath))}`);
  const bytes = readFileSync(filePath);
  // A signature check, not a validity check: it catches the wrong path — a key,
  // a dump, a text file — before its bytes leave the machine. Whether the PDF
  // is a mailable letter is still Pingen's call.
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`Keine PDF-Datei (Signatur %PDF- fehlt): ${basename(filePath)}`);
  }
  const up = await api('GET', '/file-upload');
  const { url, url_signature } = up.data?.attributes || {};
  if (!url || !url_signature) throw new Error('Upload-Slot ohne URL/Signatur erhalten.');
  // application/pdf is what the signed slot is issued for, and what the
  // official client sends; without it the bucket can refuse the object.
  const put = await http('PUT file', url, {
    method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' }, timeout: TRANSFER_TIMEOUT_MS,
  });
  if (!put.ok) throw new Error(`PUT file → ${put.status}: ${excerpt(await put.text(), 300)}`);
  return { file_url: url, file_url_signature: url_signature };
}

function letterRow(d) {
  const a = d?.attributes || {};
  return { id: d?.id, status: a.status, delivery_product: a.delivery_product, recipient: a.address, tracking: a.tracking_number, pages: a.file_pages, submitted: a.submitted_at, price: (a.price_value != null && a.price_currency) ? `${a.price_value} ${a.price_currency}` : undefined };
}

const TOOLS = [
  { name: 'pingen_status', description: 'Verify credentials and show the active Pingen organisation (name, plan, id).', inputSchema: { type: 'object', properties: {} } },
  { name: 'pingen_list_letters', description: 'List letters with status and tracking. Optional page size.', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'page size (default 20)' } } } },
  { name: 'pingen_send_letter', description: 'Upload a PDF and create a letter. By default a DRAFT (auto_send=false) — nothing is mailed until pingen_submit_letter. Set auto_send=true to send immediately.', inputSchema: { type: 'object', properties: {
      file_path: { type: 'string', description: 'absolute path to the PDF' },
      delivery_product: { type: 'string', description: 'e.g. cheap (B-Post), fast (A-Post), registered (Einschreiben), premium — CH values' },
      address_position: { type: 'string', enum: ['left', 'right'], description: 'window position of the address on the first page (default left)' },
      auto_send: { type: 'boolean', description: 'default false = create draft only' },
    }, required: ['file_path'] } },
  { name: 'pingen_submit_letter', description: 'IRREVERSIBLE AND CHARGEABLE: prints and physically mails an existing DRAFT letter. Requires confirm:true. Optional print_mode (simplex/duplex) and print_spectrum (color/grayscale).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, delivery_product: { type: 'string' }, print_mode: { type: 'string' }, print_spectrum: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['letter_id', 'delivery_product', 'confirm'] } },
  { name: 'pingen_get_letter', description: 'Get one letter status/tracking by id.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_cancel_letter', description: 'Cancel a letter that has already been submitted/sent (where cancellable).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_delete_letter', description: 'DESTRUCTIVE: delete a draft / not-yet-sent letter for good. Requires confirm:true. To stop a letter already on its way use pingen_cancel_letter instead.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['letter_id', 'confirm'] } },
  { name: 'pingen_letter_events', description: 'Tracking/status history of a letter (created, submitted, sent, delivered, undeliverable …).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_download_letter', description: 'Download the letter PDF to output_path (available once the letter is processed/sent).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, output_path: { type: 'string' } }, required: ['letter_id', 'output_path'] } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: redact(typeof s === 'string' ? s : JSON.stringify(s, null, 1)) }] });
  try {
    if (name === 'pingen_status') {
      const d = await api('GET', '/organisations');
      const orgs = (d.data || []).map(o => ({ id: o.id, name: o.attributes?.name, plan: o.attributes?.plan, status: o.attributes?.status }));
      const active = await orgId();
      // A configured UUID was reported as active without checking it is one of
      // ours: a stale or mistyped value produced a confident, false answer, and
      // every later call then 404s for reasons this tool said were fine.
      if (!orgs.some(o => o.id === active)) {
        return text({ organisations: orgs, active: null, error: `PINGEN_ORG_UUID ${active} gehört zu keiner erreichbaren Organisation` });
      }
      return text({ organisations: orgs, active });
    }
    // Before anything authenticates: an unknown name is a client bug, and
    // resolving an organisation for it both lies with isError:false and warms
    // caches on behalf of a call that was never valid.
    if (!TOOLS.some(t => t.name === name)) throw new Error(`unknown tool ${name}`);
    // Resolved where it is used, not here. The same rule has to hold for a name
    // that is advertised but has no branch below, and with the lookup up front
    // such a call authenticated, resolved an organisation, and only then fell
    // out of the chain. It is also what made the smoke test's dispatcher probe
    // meaningless: with credentials blanked every tool answered "no
    // credentials" before dispatch, so a branch deleted from the chain was
    // indistinguishable from a working one and the check passed.
    const oid = () => orgId();
    // Every tool below addresses a letter by id, and every one of them puts it
    // into a path. Validate once, here.
    const lid = args.letter_id === undefined ? undefined : letterId(args.letter_id);
    if (name === 'pingen_list_letters') {
      // The schema says number, but nothing enforces a schema on the way in: a
      // string went into the query verbatim, so "20&filter[status]=sent" added
      // a parameter of the caller's choosing to a request built here.
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit)) || 20));
      const d = await api('GET', `/organisations/${await oid()}/deliveries/letters?page[limit]=${limit}&sort=-created_at`);
      const letters = (d.data || []).map(letterRow);
      // The same page-is-not-the-whole-thing that pingen_letter_events was
      // taught about, left standing in the tool anyone actually asks "did that
      // letter go out?". An account with more letters than the page size got
      // the newest twenty back with nothing to say they were only the newest
      // twenty, so "no, there is nothing to that address" came out of a list
      // that had never been read to the end — an answer, not a failure, and
      // wrong. Pingen says how many there are; when it says nothing, a page
      // that came back exactly full is the one piece of evidence left.
      const more = d.links?.next ? true
        : d.meta?.total != null ? d.meta.total > letters.length
          : letters.length >= limit;
      // "limit erhöhen (max 100)" was told to a caller who had already asked
      // for 100, which is advice nobody can follow: the tool has no page
      // parameter, so at the largest page the older letters are simply not
      // reachable through it. A model that is told to raise a limit it is
      // already at raises it again, gets the same hundred, and asks a paid API
      // in a circle. At the cap it now says what is actually left to do.
      const hint = limit >= 100
        ? `nur die neuesten ${letters.length}, und 100 ist die grösste Seite — ältere Briefe sind über diese Liste nicht erreichbar, nur per pingen_get_letter mit bekannter letter_id`
        : `nur die neuesten ${letters.length} — Pingen hat weitere; limit erhöhen (max 100)`;
      return text({ letters, ...(more ? { truncated: true, hint } : {}) });
    }
    if (name === 'pingen_get_letter') {
      const d = await api('GET', `/organisations/${await oid()}/deliveries/letters/${lid}`);
      return text(letterRow(d.data));
    }
    if (name === 'pingen_send_letter') {
      // Which account this letter belongs to is settled before its contents
      // leave the machine. Resolving the organisation lazily at the POST meant
      // an account with several of them uploaded the PDF into Pingen's storage
      // first and refused to choose only afterwards — and that refusal exists
      // precisely so a private letter does not land at an account nobody
      // picked. Reading the file still happens after, so a wrong path costs no
      // more than one cached lookup.
      const org = await oid();
      const { file_url, file_url_signature } = await uploadFile(args.file_path);
      const attributes = {
        file_original_name: basename(args.file_path),
        file_url, file_url_signature,
        address_position: args.address_position || 'left',
        auto_send: args.auto_send === true,
      };
      if (args.delivery_product) attributes.delivery_product = args.delivery_product;
      const d = await api('POST', `/organisations/${org}/deliveries/letters`, { json: { data: { type: 'letters', attributes } } });
      // The note used to repeat the flag we sent. Pingen can answer
      // `action_required` — a letter it will not send until something is fixed
      // — and the tool said "wird versandt" about it anyway.
      const status = d.data?.attributes?.status;
      const note = !attributes.auto_send
        ? 'DRAFT erstellt (nichts versandt). Zum Senden: pingen_submit_letter.'
        : status === 'draft' || status === 'action_required' || status === 'invalid'
          ? `auto_send=true, aber Pingen meldet Status "${status}" — NICHT versandt. Details: pingen_get_letter.`
          : `auto_send=true, Pingen meldet Status "${status ?? 'unbekannt'}" → wird versandt.`;
      return text({ created: letterRow(d.data), note });
    }
    if (name === 'pingen_submit_letter') {
      // This is the one action in the suite that reaches the physical world and
      // spends money, and there is no undo once the sheet is printed. The sister
      // server gates a mere trash-can delete behind confirm:true; sending a
      // letter had no gate at all.
      if (args.confirm !== true) {
        return text({ refused: 'confirm:true is required', note: 'this prints and mails the letter at your cost, and cannot be undone — pingen_get_letter first if you are not sure which draft this is' });
      }
      // required: in the schema is a hint to the client, not a check. Sending
      // this without a product either takes whatever Pingen defaults to or
      // reuses one already on the draft — either way the letter is franked in a
      // way nobody chose, and it is already in the post by the time you look.
      if (typeof args.delivery_product !== 'string' || !args.delivery_product.trim()) {
        return text({ refused: 'delivery_product ist erforderlich', note: 'z. B. cheap (B-Post), fast (A-Post), registered (Einschreiben)' });
      }
      const attributes = { delivery_product: args.delivery_product, print_mode: args.print_mode || 'simplex', print_spectrum: args.print_spectrum || 'color' };
      const d = await api('PATCH', `/organisations/${await oid()}/deliveries/letters/${lid}/send`, { json: { data: { id: lid, type: 'letters', attributes } } });
      return text({ submitted: letterRow(d.data) });
    }
    if (name === 'pingen_cancel_letter') {
      await api('PATCH', `/organisations/${await oid()}/deliveries/letters/${lid}/cancel`, { json: { data: { id: lid, type: 'letters' } } });
      return text({ cancelled: lid });
    }
    if (name === 'pingen_delete_letter') {
      // Irreversible, and an agent tidying up is exactly when it gets called by
      // accident. Cancelling a send is a different tool and stays ungated: that
      // one is the safe direction.
      if (args.confirm !== true) {
        return text({ refused: 'confirm:true is required', note: 'the draft is gone for good; to stop a letter that is already on its way use pingen_cancel_letter' });
      }
      await api('DELETE', `/organisations/${await oid()}/deliveries/letters/${lid}`);
      return text({ deleted: lid });
    }
    if (name === 'pingen_letter_events') {
      const d = await api('GET', `/organisations/${await oid()}/deliveries/letters/${lid}/events?sort=-emitted_at`);
      // One page, and it used to be handed over as the whole history. A letter
      // with a long tracking trail then looked like it had stopped moving.
      const events = (d.data || []).map(e => ({ type: e.attributes?.type || e.type, at: e.attributes?.emitted_at, detail: e.attributes?.data }));
      const more = d.links?.next || (d.meta?.total != null && d.meta.total > events.length);
      return text({ events, ...(more ? { truncated: true, hint: 'Pingen meldet weitere Ereignisse — dies ist die erste Seite' } : {}) });
    }
    if (name === 'pingen_download_letter') {
      const r = await api('GET', `/organisations/${await oid()}/deliveries/letters/${lid}/file`, { raw: true });
      // Media types are case-insensitive. "Application/PDF" is as valid as the
      // lowercase form, and it used to be parsed as JSON and rejected.
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      let bytes;
      if (ct.includes('pdf') || ct.includes('octet-stream')) {
        bytes = Buffer.from(await r.arrayBuffer());
      } else {
        const j = JSON.parse(await r.text());
        const url = j.data?.attributes?.url || j.url;
        if (!url) throw new Error('Kein Datei-URL in der Antwort (Brief evtl. noch nicht verarbeitet).');
        // Through http(), like everything else: this used to be a bare fetch,
        // so the one request that moves the most bytes was the only unbounded
        // one in the server, and a stalled bucket hung the client for ever.
        const f = await http('Datei-Download', url, { timeout: TRANSFER_TIMEOUT_MS });
        if (!f.ok) throw new Error(`Datei-Download ${f.status}`);
        // The direct path above checks the content type; this one used to take
        // whatever came back. A bucket that answers an expired link with an XML
        // error, or a portal that answers with HTML, would have been written to
        // disk as the letter and reported as saved.
        bytes = Buffer.from(await f.arrayBuffer());
      }
      // Whichever path produced them, the bytes have to be a PDF. Saying
      // "saved" about an error page is a wrong answer, not a failure.
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error(`Antwort ist kein PDF (${bytes.length} Bytes, Signatur ${JSON.stringify(bytes.subarray(0, 5).toString('latin1'))}) — Brief evtl. noch nicht verarbeitet.`);
      }
      // A letter is correspondence. Written with the process umask it can land
      // group- and world-readable, and `w` follows a symlink at that path.
      writePrivate(args.output_path, bytes);
      return text({ saved: args.output_path, bytes: bytes.length });
    }
    // Advertised, and it reached the bottom of the chain, so nothing handles it.
    // Falling off the end returned undefined, which the client reads as a
    // successful call with no content: asking to cancel a letter was answered,
    // cheerfully and with isError:false, by nothing at all.
    throw new Error(`unknown tool ${name}`);
  } catch (e) {
    return { content: [{ type: 'text', text: redact('ERROR: ' + (e.message || String(e))) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
