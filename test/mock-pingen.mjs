// A stand-in for api.pingen.com, so the whole server can be exercised without
// an account and — the point of the exercise — without ever putting a letter in
// the post. It speaks the shapes the real v2 API returns: JSON:API envelopes,
// the two-step file upload (GET a signed slot, PUT the bytes), and a /send that
// only answers PATCH.
//
// Two endpoints are deliberately hostile, because real ones are: a rejected
// token grant quotes the client_secret it was given back at you, and one letter
// returns a 500 whose body contains the bearer token. Nothing of either may
// reach a tool result.
import { createServer } from 'node:http';

export const ORG = 'org-test-1';
export const TOKEN = 'tok-pingen-abcdef123456';

const letter = (id, over = {}) => ({
  id,
  type: 'letters',
  attributes: {
    status: 'sent',
    delivery_product: 'fast',
    // Deliberately not address-shaped: the hygiene scan looks for exactly that
    // pattern, and a fixture must not be the thing the gate is there to catch.
    address: 'Example AG\nExample Line 1\nExample City',
    tracking_number: '98.12.345678.90',
    file_pages: 2,
    submitted_at: '2026-07-01T09:15:00+00:00',
    created_at: '2026-07-01T09:00:00+00:00',
    price_value: 1.85,
    price_currency: 'CHF',
    ...over,
  },
});

export function start({ tokenStatus = 200, tokenBody = null } = {}) {
  const state = {
    calls: [],            // "METHOD /path", in order
    urls: [],             // the same requests with their query string
    authHeaders: [],      // every Authorization header the API saw
    tokenGrants: 0,
    nextStatus: null,      // force the next created letter's status
    uploads: [],          // { slot, bytes }
    created: [],          // attributes of every POSTed letter
    submitted: [],        // { id, attributes } of every PATCH .../send
    cancelled: [],
    deleted: [],
    uploadStatus: 200,    // flip to fail the PUT of the bytes
    slotBroken: false,    // flip to hand out a slot without a URL
    // A real authorisation server hands out a different bearer every time and
    // says how long it lasts. Answering with one constant token for ever meant
    // a server that had lost track of a token it used to hold looked exactly
    // like one that had not. Off by default, so nothing else changes.
    rotateTokens: false,
    tokenTtl: 3600,       // drop this and the server re-grants on every call
    issuedTokens: [],
    // Set to a promise to hold the letter that fails loudly open, so a second
    // call can overtake it while its response is still on the way back.
    holdLeak: null,
    orgs: [{ id: ORG, type: 'organisations', attributes: { name: 'Test Org', plan: 'free', status: 'active' } }],
    letters: [
      // Deliberately out of order in the array: the API is asked for
      // newest-first, and a mock that hands back insertion order cannot show
      // whether that was honoured.
      letter('ltr-1', { created_at: '2026-07-03T09:00:00+00:00' }),
      letter('ltr-2', { status: 'draft', tracking_number: null, submitted_at: null, price_value: null, price_currency: null, created_at: '2026-07-01T09:00:00+00:00' }),
      letter('ltr-3', { created_at: '2026-07-02T09:00:00+00:00' }),
      letter('ltr-leak'),
    ],
  };

  let base = '';
  // Any bearer this mock has actually issued, not one hardcoded name: with
  // rotation on there is more than one, and every one of them was valid when it
  // was handed out.
  const bearerOk = req => {
    const h = req.headers.authorization || '';
    return h === `Bearer ${TOKEN}` || state.issuedTokens.some(t => h === `Bearer ${t}`);
  };
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.calls.push(`${req.method} ${p}`);
    state.urls.push(`${req.method} ${req.url}`);
    const send = (code, body, type = 'application/vnd.api+json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const read = () => new Promise(resolve => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // --- OAuth2 client_credentials ------------------------------------------
    if (p === '/auth/access-tokens') {
      if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
      const rawBody = (await read()).toString();
      const form = new URLSearchParams(rawBody);
      state.tokenGrants++;
      if (tokenStatus !== 200 || tokenBody) {
        // Exactly the unhelpful thing a real authorisation server does: quote
        // the offending credential back — once JSON-escaped in a message, once
        // percent-encoded in an echo of the request body.
        return send(tokenStatus, tokenBody ?? JSON.stringify({
          error: 'invalid_client',
          hint: `secret ${form.get('client_secret')} rejected`,
          request_body: rawBody,
        }));
      }
      if (form.get('grant_type') !== 'client_credentials' || !form.get('client_id') || !form.get('client_secret')) {
        return send(400, { error: 'invalid_request' });
      }
      const issued = state.rotateTokens ? `${TOKEN}-g${state.tokenGrants}` : TOKEN;
      state.issuedTokens.push(issued);
      return send(200, { access_token: issued, token_type: 'bearer', expires_in: state.tokenTtl });
    }

    // --- the signed upload slot, and the bucket it points at -----------------
    if (p === '/file-upload' && req.method === 'GET') {
      if (!bearerOk(req)) return send(401, { error: 'unauthorized' });
      state.authHeaders.push(req.headers.authorization || '');
      if (state.slotBroken) return send(200, { data: { type: 'file_uploads', attributes: {} } });
      return send(200, { data: { type: 'file_uploads', attributes: { url: `${base}/upload-slot/slot-1`, url_signature: 'sig-1' } } });
    }
    if (p.startsWith('/upload-slot/') && req.method === 'PUT') {
      const bytes = await read();
      // The signed slot is issued for application/pdf, and a bucket can refuse
      // the object without it. Accepting any type here meant dropping the
      // header in production would have left every test green.
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/pdf')) return send(400, { error: 'bad_content_type', got: ct }, 'application/json');
      if (state.uploadStatus !== 200) return send(state.uploadStatus, 'upload rejected', 'text/plain');
      state.uploads.push({ slot: p.slice('/upload-slot/'.length), bytes });
      return send(200, '', 'text/plain');
    }
    if (p.startsWith('/blob/') && req.method === 'GET') {
      return send(200, Buffer.from('%PDF-1.7 fetched-from-blob'), 'application/pdf');
    }

    // --- everything else needs the bearer token ------------------------------
    if (!bearerOk(req)) return send(401, { error: 'unauthorized' });
    state.authHeaders.push(req.headers.authorization || '');

    if (p === '/organisations' && req.method === 'GET') return send(200, { data: state.orgs });

    const m = /^\/organisations\/([^/]+)\/deliveries\/letters(?:\/([^/]+))?(?:\/(\w+))?$/.exec(p);
    if (!m) return send(404, { error: 'no_route', path: p });
    const [, oid, id, tail] = m;
    if (oid !== ORG) return send(404, { error: 'unknown_organisation', id: oid });

    if (!id) {
      if (req.method === 'GET') {
        const limit = Number(url.searchParams.get('page[limit]') || 20);
        // The mock used to ignore sort entirely, so a regression that asked for
        // oldest-first — or forgot to ask at all — was invisible here.
        const sort = url.searchParams.get('sort');
        if (sort !== '-created_at') return send(400, { error: 'unsupported_sort', got: sort });
        const newestFirst = [...state.letters].sort((a, b) =>
          String(b.attributes?.created_at || '').localeCompare(String(a.attributes?.created_at || '')));
        const page = newestFirst.slice(0, limit);
        // The real collection endpoint paginates and says so, with the total in
        // meta and a next link. Answering with a bare `data` array meant a tool
        // that handed one page over as the whole list looked exactly like one
        // that had read the list to the end.
        return send(200, {
          data: page,
          links: { next: page.length < newestFirst.length ? `${base}/organisations/${ORG}/deliveries/letters?page[number]=2` : null },
          meta: { total: newestFirst.length, per_page: limit, current_page: 1 },
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await read()).toString() || '{}');
        const attributes = body.data?.attributes || {};
        state.created.push(attributes);
        const created = letter(`ltr-new-${state.created.length}`, {
          ...attributes,
          // Pingen can accept a letter and still refuse to send it. A test sets
          // state.nextStatus to make it answer that way once.
          status: state.nextStatus || (attributes.auto_send ? 'processing' : 'draft'),
          tracking_number: null,
          submitted_at: attributes.auto_send ? '2026-07-27T10:00:00+00:00' : null,
        });
        state.letters.push(created);
        return send(201, { data: created });
      }
      return send(405, { error: 'method_not_allowed' });
    }

    const known = state.letters.find(l => l.id === id);
    if (!known) return send(404, { error: 'not_found', id });

    // The letter that makes the upstream fail loudly, token and all. Held open
    // when a test asks for it, so the bearer quoted back here can be one the
    // server has already replaced by the time it reads the answer.
    if (id === 'ltr-leak' && tail !== 'file') {
      if (state.holdLeak) await state.holdLeak;
      return send(500, `{"error":"internal","request":{"authorization":"${req.headers.authorization}"}}`);
    }

    if (tail === 'send') {
      // The real API only accepts PATCH here; a POST must not silently work.
      if (req.method !== 'PATCH') return send(405, { error: 'method_not_allowed', allowed: ['PATCH'] });
      const body = JSON.parse((await read()).toString() || '{}');
      state.submitted.push({ id, attributes: body.data?.attributes || {} });
      known.attributes = { ...known.attributes, ...body.data?.attributes, status: 'processing', submitted_at: '2026-07-27T10:00:00+00:00' };
      return send(200, { data: known });
    }
    if (tail === 'cancel') {
      if (req.method !== 'PATCH') return send(405, { error: 'method_not_allowed', allowed: ['PATCH'] });
      state.cancelled.push(id);
      known.attributes.status = 'cancelled';
      return send(204, '');
    }
    if (tail === 'events' && req.method === 'GET') {
      return send(200, { data: [
        { id: 'ev-1', type: 'letter_events', attributes: { type: 'letter.created', emitted_at: '2026-07-01T09:00:00+00:00', data: { by: 'api' } } },
        { id: 'ev-2', type: 'letter_events', attributes: { type: 'letter.sent', emitted_at: '2026-07-01T09:30:00+00:00', data: null } },
      ] });
    }
    if (tail === 'file' && req.method === 'GET') {
      // Three shapes the API is known to answer with, all of which the tool
      // has to cope with: the bytes, a pointer to them, or neither.
      if (id === 'ltr-1') return send(200, Buffer.from('%PDF-1.4 direct-bytes'), 'application/pdf');
      if (id === 'ltr-2') return send(200, { data: { attributes: { url: `${base}/blob/${id}.pdf` } } }, 'application/json');
      return send(200, { data: { attributes: {} } }, 'application/json');
    }
    if (!tail) {
      if (req.method === 'GET') return send(200, { data: known });
      if (req.method === 'DELETE') {
        state.deleted.push(id);
        state.letters = state.letters.filter(l => l.id !== id);
        return send(204, '');
      }
    }
    return send(404, { error: 'no_route', path: p, method: req.method });
  });

  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${srv.address().port}`;
      resolve({ base, state, close: () => new Promise(r => srv.close(r)) });
    });
  });
}
