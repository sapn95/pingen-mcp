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
import { AsyncLocalStorage } from 'node:async_hooks';

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
// set is bounded by eight plus however many bearers the tool calls in flight
// have used, which is bounded by the client, and every bearer that can still
// come back quoted is in it.
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
function holdToken(t) { tokensOut.set(t, (tokensOut.get(t) ?? 0) + 1); }
function releaseToken(t) {
  const n = (tokensOut.get(t) ?? 0) - 1;
  if (n > 0) tokensOut.set(t, n); else tokensOut.delete(t);
  forgetSpent();
}

// The pin used to last exactly as long as the HTTP request, and the note above
// it claimed that was "until its answer has been turned into a result or a
// message — which is where redact() runs". It is not: redact() runs in the
// dispatcher, after api() has returned. For most calls that gap is harmless
// because the body is already read and already excerpted by then, but the
// download hands its response back unread — fetch resolves on the headers — so
// the bearer was unpinned before a single byte of the answer had arrived. A
// dozen grants while the body was still on the way, and the token that answer
// was about to quote was the first one dropped; it reached the tool result
// verbatim, still valid. The same gap opens for any call once more than eight
// bearers are pinned, because then the one just released is the oldest
// forgettable thing in the set at the instant its own result is being built.
//
// So the interval that holds is the tool call, which is the one that ends at
// redact(). Each call collects the bearers it used and lets go of all of them
// at the end; the request is a strict sub-interval of that, so it no longer
// needs a pin of its own.
const callBearers = new AsyncLocalStorage();
function pinForCall(t) {
  const used = callBearers.getStore();
  // No scope means nobody would ever unpin it, and a bearer pinned for ever is
  // a set that grows for ever — exactly what the bound exists to prevent. Every
  // path that reaches here today runs inside a tool call; one that did not
  // would go unpinned rather than uncollectable.
  if (!used || used.has(t)) return;
  used.add(t);
  holdToken(t);
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
  // This is the bearer that can come back quoted, so it stays known to the
  // redactor until the tool call that used it has been answered — see
  // pinForCall. Pinning it for the length of the request was not enough.
  pinForCall(bearer);
  const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.api+json' };
  let bodyInit;
  if (json !== undefined) { headers['Content-Type'] = 'application/vnd.api+json'; bodyInit = JSON.stringify(json); }
  const r = await http(`${method} ${path}`, apiUrl(path), { method, headers, body: bodyInit, timeout: raw ? TRANSFER_TIMEOUT_MS : TIMEOUT_MS });
  // A 401 means the request was refused before it did anything, so retrying it
  // once with a fresh token is safe even for a mutation — and it is the
  // difference between a revoked token costing one call and costing every call
  // until the process restarts. Awaited rather than handed back so that a stack
  // trace still names this frame.
  if (r.status === 401 && retry) {
    token = null; tokenExp = 0;
    return await api(method, path, { json, raw, retry: false });
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${excerpt(await r.text(), 500)}`);
  if (raw) return r;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : {};
}

// Discovered once and remembered, and — like the token — looked up only once
// even if several tool calls arrive together.
let pendingOrg = null;
function orgId() {
  if (ORG) return Promise.resolve(ORG);
  pendingOrg ??= discoverOrg().finally(() => { pendingOrg = null; });
  return pendingOrg;
}
// /organisations is a collection and paginates like every other one here, and
// it is the collection where reading a page as the whole list decides which
// account pays for and franks a letter. Both other list tools were taught that
// lesson; this one was never looked at, because with one organisation in the
// account the page and the list are the same thing and nothing ever disagreed.
// The page size is asked for rather than left to the API, for the same reason as
// the tracking trail: a caller that does not say how big a page it wants cannot
// tell a full one from a short one. What the answer volunteers is better
// evidence than that, so the count and the next link are read first.
//
// Asking is necessary and not sufficient, and it is worth writing down how far
// it reaches: a page size is a request, and if the API hands back fewer than
// this because it caps the page, then a full page never looks full and the last
// branch below can never fire. It is the largest page pingen_list_letters
// believes exists, so against this API the case does not arise; against one that
// capped lower AND said nothing about a total, a first page would be read as the
// whole list. That is undecidable from a single answer, and it cannot make the
// billing guard stand down — any cap above one already leaves more than one
// organisation on the page, which is the question discoverOrg asks.
const ORG_PAGE = 100;
async function listOrganisations() {
  const d = await api('GET', `/organisations?page[limit]=${ORG_PAGE}`);
  const orgs = d.data || [];
  const more = d.links?.next ? true
    : d.meta?.total != null ? d.meta.total > orgs.length
      : orgs.length >= ORG_PAGE;
  return { orgs, more };
}
async function discoverOrg() {
  const { orgs, more } = await listOrganisations();
  if (!orgs.length) throw new Error('Keine Organisation gefunden.');
  // Only auto-select when there is nothing to choose. With several, taking the
  // first one off a collection would decide — silently — which account pays for
  // and franks the letter.
  //
  // "Several" used to mean "several on the page that came back", which is not
  // the same question. An account whose organisations do not fit one page hands
  // back a page of one, and a page of one is indistinguishable from an account
  // that has one — so the guard stood down and the first entry of an
  // alphabetical page became the account the letter was billed to, with nothing
  // said. A list that admits to being incomplete is a choice, not a default.
  if (orgs.length > 1 || more) {
    const count = more ? `Mindestens ${orgs.length}` : `${orgs.length}`;
    throw new Error(`${count} Organisationen — PINGEN_ORG_UUID setzen: ${orgs.map(o => `${o.id} (${o.attributes?.name})`).join(', ')}${more ? ' — und das ist nur die erste Seite' : ''}`);
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

// The statuses that say a letter is still sitting with Pingen and nothing has
// been printed, and the ones that say it has been taken for printing. Two named
// lists rather than one, because everything else — a status this version has
// never heard of, or none at all — belongs in neither and has to be reported as
// what it is. Read the note below for what went wrong without them.
const RESTING = new Set(['draft', 'valid', 'action_required', 'invalid']);
const MOVING = new Set(['processing', 'sending', 'sent', 'delivered']);

// Two of the four resting statuses do not mean "waiting to be sent", they mean
// "waiting to be fixed": Pingen has looked at the PDF and will not take it —
// the address could not be read out of the window, or the franking zone is
// covered. The README devotes a whole section to that case because it is the
// one everybody hits, and it says in as many words that such a letter cannot be
// submitted. The create note said the opposite. See the note at the branch.
const BLOCKED = new Set(['action_required', 'invalid']);

// How much of a tracking trail to ask for in one go. A letter's history is a
// handful of entries, so this is far more than any real one has — which is the
// point: the number exists so that a page coming back exactly this full is
// evidence of more, and a threshold nothing ever reaches raises no false alarm.
const EVENT_PAGE = 100;

const TOOLS = [
  { name: 'pingen_status', description: 'Verify credentials and show the active Pingen organisation (name, plan, id).', inputSchema: { type: 'object', properties: {} } },
  { name: 'pingen_list_letters', description: 'List letters with status and tracking. Optional page size.', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'page size (default 20)' } } } },
  { name: 'pingen_send_letter', description: 'Upload a PDF and create a letter. By default a DRAFT (auto_send=false) — nothing is mailed until pingen_submit_letter. Set auto_send=true to mail immediately; that path also requires delivery_product, because it is the one route that never reaches pingen_submit_letter and so nothing asks for a product later.', inputSchema: { type: 'object', properties: {
      file_path: { type: 'string', description: 'absolute path to the PDF' },
      delivery_product: { type: 'string', description: 'e.g. cheap (B-Post), fast (A-Post), registered (Einschreiben), premium — CH values. Optional for a draft, required with auto_send=true' },
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

const callTool = async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: redact(typeof s === 'string' ? s : JSON.stringify(s, null, 1)) }] });
  try {
    if (name === 'pingen_status') {
      const { orgs: found, more } = await listOrganisations();
      const orgs = found.map(o => ({ id: o.id, name: o.attributes?.name, plan: o.attributes?.plan, status: o.attributes?.status }));
      const active = await orgId();
      // A configured UUID was reported as active without checking it is one of
      // ours: a stale or mistyped value produced a confident, false answer, and
      // every later call then 404s for reasons this tool said were fine.
      if (!orgs.some(o => o.id === active)) {
        // The check itself then produced the mirror-image wrong answer, for the
        // same reason: absent from the page it read is not absent from the
        // account. A correctly configured UUID that happened to sort onto a
        // later page was announced as belonging to no reachable organisation —
        // an answer, not a failure, and one that sends the reader off to fix a
        // setting that was never broken.
        if (more) {
          return text({ organisations: orgs, truncated: true, active, note: `Nur die erste Seite der Organisationen — ob ${active} dazugehört, ist damit nicht entschieden; die Aufrufe darunter zeigen es.` });
        }
        return text({ organisations: orgs, active: null, error: `PINGEN_ORG_UUID ${active} gehört zu keiner erreichbaren Organisation` });
      }
      return text({ organisations: orgs, ...(more ? { truncated: true } : {}), active });
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
      // delivery_product is optional here for one reason only: a draft is
      // franked later, by pingen_submit_letter, and that call refuses to run
      // without one — "required: in a schema is a hint, not a check" was
      // written about exactly that. auto_send=true is the single path that
      // never reaches submit, so on that path the promise "somebody will be
      // asked which product" is kept by nobody: the letter was uploaded,
      // accepted, printed and franked with whatever Pingen falls back to, and
      // the tool reported "wird versandt" over the top of it. The gate that
      // guards the second step has to guard the shortcut past it as well.
      // Refused up here, so it costs no token, no organisation lookup and no
      // upload, the same way an unconfirmed submit does.
      if (args.auto_send === true && (typeof args.delivery_product !== 'string' || !args.delivery_product.trim())) {
        return text({ refused: 'delivery_product ist bei auto_send=true erforderlich', note: 'auto_send=true druckt und frankiert den Brief sofort — ohne Produkt entscheidet Pingen, und der Brief ist bereits unterwegs, wenn man nachschaut. z. B. cheap (B-Post), fast (A-Post), registered (Einschreiben). Ohne auto_send entsteht ein Entwurf, und das Produkt wird bei pingen_submit_letter gewählt.' });
      }
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
      // The note used to repeat the flag we sent, and half of it still did. The
      // auto_send=true half was taught to read Pingen's status back, but as a
      // denylist of three names: every other answer — a status this code had
      // never heard of, or an answer carrying none, which came out as
      // "Status \"unbekannt\" → wird versandt" — was a claim about the physical
      // post made from ignorance. The auto_send=false half read nothing at all,
      // and that is the more expensive one: Pingen answering anything other
      // than a draft state was still reported as "nichts versandt, zum Senden
      // pingen_submit_letter", which is an instruction to put the same letter
      // in the post a second time, at cost and with no undo.
      //
      // So both halves are decided by the status that came back, and a status
      // in neither list is reported as unknown rather than guessed at.
      //
      // That was said of both halves and was true of one. The auto_send=false
      // half had two answers where it needed three: everything that was not a
      // resting state was announced as "das ist kein Entwurfszustand", which is
      // a positive claim about a status this code has never seen — and, for an
      // answer carrying none at all, the very sentence the round before had been
      // written to remove, only pointing the other way: it said in one breath
      // that it did not know the status and that it knew the letter was not a
      // draft. The cost is not hypothetical. Let Pingen add one pre-print state
      // this version predates and every ordinary draft creation starts answering
      // "NICHT mit pingen_submit_letter nachfassen" — which is the whole flow of
      // this server, talked out of itself by a guess.
      //
      // And the resting half was still one sentence for four statuses. Two of
      // them are Pingen saying it has read the PDF and will not take it —
      // action_required, invalid — and both of those were answered with "DRAFT
      // erstellt (nichts versandt). Zum Senden: pingen_submit_letter.", which
      // is this server telling the caller to post a letter its own README says
      // cannot be posted, in the single most common failure there is: the
      // address did not sit in the window. It was also the one branch of the
      // six that never repeated what Pingen had answered, so the sentence a
      // reader actually reads said "ready" while the status three lines above
      // it said "not ready". The sibling half has said "NICHT versandt.
      // Details: pingen_get_letter." about those same two statuses since round
      // 15; this half was never given it.
      const status = d.data?.attributes?.status;
      const shown = status ?? 'keinen';
      const note = !attributes.auto_send
        ? BLOCKED.has(status)
          ? `Entwurf erstellt, nichts versandt — aber Pingen meldet Status "${shown}" und nimmt den Brief so nicht zum Druck an. Ursache prüfen: pingen_get_letter oder das Dashboard (bei action_required meist Adressfenster oder Frankierzone im PDF), dann ein korrigiertes PDF hochladen. pingen_submit_letter bringt ihn in diesem Zustand nicht auf den Weg.`
          : RESTING.has(status)
            ? 'DRAFT erstellt (nichts versandt). Zum Senden: pingen_submit_letter.'
            : MOVING.has(status)
              ? `auto_send=false, aber Pingen meldet Status "${shown}" — der Brief ist bereits zum Druck angenommen. NICHT mit pingen_submit_letter nachfassen, sonst geht er zweimal raus. Prüfen: pingen_get_letter.`
              : `auto_send=false, und Pingen meldet Status "${shown}" — den kennt dieser Server nicht; ob der Brief ein Entwurf ist oder schon läuft, sagt das nicht. Erst pingen_get_letter, dann entscheiden, ob pingen_submit_letter nötig ist — blind nachfassen kann ihn zweimal rausschicken.`
        : RESTING.has(status)
          ? `auto_send=true, aber Pingen meldet Status "${shown}" — NICHT versandt. Details: pingen_get_letter.`
          : MOVING.has(status)
            ? `auto_send=true, Pingen meldet Status "${shown}" → wird versandt.`
            : `auto_send=true, Pingen meldet Status "${shown}" — ob der Brief unterwegs ist, sagt das nicht. Prüfen: pingen_get_letter.`;
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
      // "submitted" used to be the whole answer, and it was concluded from the
      // PATCH having come back 2xx — that is, from the request we made rather
      // than from the answer we got. Twice now that same reasoning has been
      // taken out of pingen_send_letter's note, and both times the tool that
      // actually prints and posts was left with it. Pingen can accept this call
      // and leave the letter exactly where it was: a draft it will not take
      // until the address is readable comes back 200, status action_required,
      // under a key that reads as a receipt. "Your letter has been mailed" is
      // then a false statement about the physical world in the direction nobody
      // checks — the bill is never posted and nobody goes looking, because the
      // tool said it was.
      //
      // Same two lists as the create path, and the same rule: a status in
      // neither of them, or none at all, is reported as not knowing rather than
      // as a send.
      //
      // The note was given that rule and the key beside it was not, which is
      // odd, because the key is what the diagnosis above had named: the answer
      // came back "under a key that reads as a receipt". It still did. A letter
      // Pingen had left sitting in action_required was handed over as
      // {"submitted": {…}} with a note underneath saying it was NICHT unterwegs
      // — the same one-breath contradiction this pair of tools has now been
      // taken apart for three rounds running, and the half that a skim reads is
      // the key, not the sentence. So the receipt is issued only when Pingen
      // says it took the letter; otherwise the letter still comes back, under a
      // name that claims nothing either way, and the note says what is known.
      //
      // And the resting branch here ended "danach erneut senden", which is the
      // same advice the create note was taken apart for the round before, in
      // the same two statuses, under a different verb. BLOCKED was written for
      // exactly this — Pingen has read the PDF and will not take it — and then
      // applied in one of the two places that branch on RESTING. Left as it
      // was, the pair now contradicted each other about an identical status:
      // pingen_send_letter said "submit will not move it, upload a corrected
      // PDF" and pingen_submit_letter said "have another go", so which of the
      // two a reader saw last decided whether the address got fixed or the same
      // refusal got asked for again. This branch is the one being read at the
      // moment it matters, because it is the answer to the call that was meant
      // to put the letter in the post — and the retry it recommends is free, so
      // there is no bill to notice that the letter never went.
      const status = d.data?.attributes?.status;
      const shown = status ?? 'keinen';
      const accepted = MOVING.has(status);
      const note = accepted
        ? `Pingen meldet Status "${shown}" — zum Druck angenommen, der Brief geht raus.`
        : BLOCKED.has(status)
          ? `Pingen meldet Status "${shown}" — der Brief ist NICHT unterwegs, und Pingen nimmt ihn in diesem Zustand auch nicht zum Druck an: ein zweiter Aufruf von pingen_submit_letter bringt ihn so nicht auf den Weg. Ursache prüfen: pingen_get_letter oder das Dashboard (bei action_required meist Adressfenster oder Frankierzone im PDF), dann ein korrigiertes PDF mit pingen_send_letter hochladen.`
          : RESTING.has(status)
            ? `Pingen meldet Status "${shown}" — der Brief liegt weiterhin bei Pingen und ist NICHT unterwegs. Ursache prüfen: pingen_get_letter, danach erneut senden.`
            : `Pingen meldet Status "${shown}" — ob der Brief unterwegs ist, sagt das nicht. Prüfen: pingen_get_letter, und nicht blind ein zweites Mal senden.`;
      const row = letterRow(d.data);
      return text({ ...(accepted ? { submitted: row } : { letter: row }), note });
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
      // The page size is asked for rather than left to the API. This tool was
      // the first one taught that a page is not the whole list, and then
      // pingen_list_letters was taught the same lesson better: when the answer
      // carries neither a next link nor a total, a page that came back exactly
      // full is the one piece of evidence left that there is more. That third
      // branch was never brought back here — and it could not have been, because
      // a caller that never says how big a page it wants cannot recognise a full
      // one. So it says.
      const d = await api('GET', `/organisations/${await oid()}/deliveries/letters/${lid}/events?page[limit]=${EVENT_PAGE}&sort=-emitted_at`);
      // One page, and it used to be handed over as the whole history. A letter
      // with a long tracking trail then looked like it had stopped moving.
      const events = (d.data || []).map(e => ({ type: e.attributes?.type || e.type, at: e.attributes?.emitted_at, detail: e.attributes?.data }));
      const more = d.links?.next ? true
        : d.meta?.total != null ? d.meta.total > events.length
          : events.length >= EVENT_PAGE;
      // Newest first, so what is missing is the old end of the trail — which is
      // worth saying, because "the first page" alone reads like the beginning of
      // the story rather than the end of it.
      return text({ events, ...(more ? { truncated: true, hint: 'Pingen meldet weitere Ereignisse — dies ist nur die erste Seite, neueste zuerst; die ältesten Einträge fehlen' } : {}) });
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
};

// Wrapped rather than registered directly: the redact() calls inside callTool
// are the last thing that happens to a string before it leaves this process, so
// every bearer the call reached for has to still be known to the redactor when
// they run. Releasing here, and only here, is what makes that true.
server.setRequestHandler(CallToolRequestSchema, async req => {
  const used = new Set();
  try {
    return await callBearers.run(used, () => callTool(req));
  } finally {
    for (const b of used) releaseToken(b);
  }
});

await server.connect(new StdioServerTransport());
