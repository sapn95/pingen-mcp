#!/usr/bin/env node
// pingen-mcp — MCP server for Pingen v2 (https://pingen.com): send physical
// letters (A-Post / B-Post / registered / Einschreiben) from a PDF via the
// Pingen REST API, and track their status.
//
// Auth: OAuth2 client_credentials. Credentials are read from env or, on macOS,
// from the login keychain (service names pingen-mcp-client-id /
// -client-secret / -org-uuid). NEVER commit credentials.
//
// Safety: send_letter creates a DRAFT by default (auto_send=false). Nothing is
// physically mailed until submit_letter is called explicitly.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const API = process.env.PINGEN_API_BASE || 'https://api.pingen.com';

function keychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'pingen', '-s', service, '-w'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
const CLIENT_ID = process.env.PINGEN_CLIENT_ID || keychain('pingen-mcp-client-id');
const CLIENT_SECRET = process.env.PINGEN_CLIENT_SECRET || keychain('pingen-mcp-client-secret');
let ORG = process.env.PINGEN_ORG_UUID || keychain('pingen-mcp-org-uuid');

let token = null, tokenExp = 0;
async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Keine Pingen-Credentials (env oder Keychain pingen-mcp-client-id/-secret).');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const r = await fetch(`${API}/auth/access-tokens`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Token-Fehler ${r.status}: ${await r.text()}`);
  const j = await r.json();
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 43200) * 1000;
  return token;
}

async function api(method, path, { json, raw } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/vnd.api+json' };
  let bodyInit;
  if (json !== undefined) { headers['Content-Type'] = 'application/vnd.api+json'; bodyInit = JSON.stringify(json); }
  const r = await fetch(`${API}${path}`, { method, headers, body: bodyInit });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 500)}`);
  if (raw) return r;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : {};
}

async function orgId() {
  if (ORG) return ORG;
  const d = await api('GET', '/organisations');
  ORG = d.data?.[0]?.id;
  if (!ORG) throw new Error('Keine Organisation gefunden.');
  return ORG;
}

// Upload a local PDF: GET /file-upload → PUT bytes → returns {url, signature}
async function uploadFile(filePath) {
  const up = await api('GET', '/file-upload');
  const { url, url_signature } = up.data.attributes;
  const bytes = readFileSync(filePath);
  const put = await fetch(url, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`PUT file → ${put.status}: ${(await put.text()).slice(0, 300)}`);
  return { file_url: url, file_url_signature: url_signature };
}

function letterRow(d) {
  const a = d.attributes || {};
  return { id: d.id, status: a.status, delivery_product: a.delivery_product, recipient: a.address, tracking: a.tracking_number, pages: a.file_pages, submitted: a.submitted_at, price: a.price_currency ? `${a.price_value} ${a.price_currency}` : undefined };
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
  { name: 'pingen_submit_letter', description: 'Send an existing DRAFT letter with a delivery product (this physically mails it). Optional print_mode (simplex/duplex) and print_spectrum (color/grayscale).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, delivery_product: { type: 'string' }, print_mode: { type: 'string' }, print_spectrum: { type: 'string' } }, required: ['letter_id', 'delivery_product'] } },
  { name: 'pingen_get_letter', description: 'Get one letter status/tracking by id.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_cancel_letter', description: 'Cancel a letter that has already been submitted/sent (where cancellable).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_delete_letter', description: 'Delete a draft / not-yet-sent letter (removes it from the dashboard).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_letter_events', description: 'Tracking/status history of a letter (created, submitted, sent, delivered, undeliverable …).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'pingen_download_letter', description: 'Download the letter PDF to output_path (available once the letter is processed/sent).', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, output_path: { type: 'string' } }, required: ['letter_id', 'output_path'] } },
];

const server = new Server({ name: 'pingen-mcp', version: '0.2.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'pingen_status') {
      const d = await api('GET', '/organisations');
      return text({ organisations: (d.data || []).map(o => ({ id: o.id, name: o.attributes?.name, plan: o.attributes?.plan, status: o.attributes?.status })), active: await orgId() });
    }
    const oid = await orgId();
    if (name === 'pingen_list_letters') {
      const d = await api('GET', `/organisations/${oid}/deliveries/letters?page[limit]=${args.limit || 20}&sort=-created_at`);
      return text({ letters: (d.data || []).map(letterRow) });
    }
    if (name === 'pingen_get_letter') {
      const d = await api('GET', `/organisations/${oid}/deliveries/letters/${args.letter_id}`);
      return text(letterRow(d.data));
    }
    if (name === 'pingen_send_letter') {
      const { file_url, file_url_signature } = await uploadFile(args.file_path);
      const attributes = {
        file_original_name: basename(args.file_path),
        file_url, file_url_signature,
        address_position: args.address_position || 'left',
        auto_send: args.auto_send === true,
      };
      if (args.delivery_product) attributes.delivery_product = args.delivery_product;
      const d = await api('POST', `/organisations/${oid}/deliveries/letters`, { json: { data: { type: 'letters', attributes } } });
      return text({ created: letterRow(d.data), note: attributes.auto_send ? 'auto_send=true → wird versandt' : 'DRAFT erstellt (nichts versandt). Zum Senden: pingen_submit_letter.' });
    }
    if (name === 'pingen_submit_letter') {
      const attributes = { delivery_product: args.delivery_product, print_mode: args.print_mode || 'simplex', print_spectrum: args.print_spectrum || 'color' };
      const d = await api('PATCH', `/organisations/${oid}/deliveries/letters/${args.letter_id}/send`, { json: { data: { id: args.letter_id, type: 'letters', attributes } } });
      return text({ submitted: letterRow(d.data) });
    }
    if (name === 'pingen_cancel_letter') {
      await api('PATCH', `/organisations/${oid}/deliveries/letters/${args.letter_id}/cancel`, { json: { data: { id: args.letter_id, type: 'letters' } } });
      return text({ cancelled: args.letter_id });
    }
    if (name === 'pingen_delete_letter') {
      await api('DELETE', `/organisations/${oid}/deliveries/letters/${args.letter_id}`);
      return text({ deleted: args.letter_id });
    }
    if (name === 'pingen_letter_events') {
      const d = await api('GET', `/organisations/${oid}/deliveries/letters/${args.letter_id}/events?sort=-emitted_at`);
      return text({ events: (d.data || []).map(e => ({ type: e.attributes?.type || e.type, at: e.attributes?.emitted_at, detail: e.attributes?.data })) });
    }
    if (name === 'pingen_download_letter') {
      const r = await api('GET', `/organisations/${oid}/deliveries/letters/${args.letter_id}/file`, { raw: true });
      const ct = r.headers.get('content-type') || '';
      let bytes;
      if (ct.includes('pdf') || ct.includes('octet-stream')) {
        bytes = Buffer.from(await r.arrayBuffer());
      } else {
        const j = JSON.parse(await r.text());
        const url = j.data?.attributes?.url || j.url;
        if (!url) throw new Error('Kein Datei-URL in der Antwort (Brief evtl. noch nicht verarbeitet).');
        const f = await fetch(url); if (!f.ok) throw new Error(`Datei-Download ${f.status}`);
        bytes = Buffer.from(await f.arrayBuffer());
      }
      writeFileSync(args.output_path, bytes);
      return text({ saved: args.output_path, bytes: bytes.length });
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
