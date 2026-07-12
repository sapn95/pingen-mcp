# pingen-mcp

MCP server for [Pingen v2](https://pingen.com) — send physical letters
(A-Post / B-Post / **registered / Einschreiben**) from a PDF and track their
status, straight from any MCP client. Uses the official Pingen REST API
(no browser automation), data hosted in Switzerland.

## Auth

OAuth2 `client_credentials`. Create an OAuth client in the Pingen dashboard
(Settings → API), then provide the credentials via **env vars** or, on macOS,
the **login keychain**:

```bash
security add-generic-password -a pingen -s pingen-mcp-client-id     -w "<CLIENT_ID>"     -U
security add-generic-password -a pingen -s pingen-mcp-client-secret -w "<CLIENT_SECRET>" -U
# optional (auto-detected from /organisations otherwise):
security add-generic-password -a pingen -s pingen-mcp-org-uuid      -w "<ORG_UUID>"      -U
```

Env-var alternative: `PINGEN_CLIENT_ID`, `PINGEN_CLIENT_SECRET`,
`PINGEN_ORG_UUID`, `PINGEN_API_BASE` (default `https://api.pingen.com`).

**Never commit credentials.**

## Tools

| Tool | Purpose |
| --- | --- |
| `pingen_status` | verify credentials, show the active organisation |
| `pingen_list_letters` | list letters with status + tracking |
| `pingen_send_letter` | upload a PDF and create a letter — **DRAFT by default** (`auto_send=false`) |
| `pingen_submit_letter` | send an existing draft with a delivery product (physically mails it) |
| `pingen_get_letter` | status/tracking of one letter |
| `pingen_cancel_letter` | cancel a not-yet-sent letter |

### Safety

`pingen_send_letter` creates a **draft** unless you pass `auto_send: true`.
Nothing is physically mailed until you call `pingen_submit_letter` (or send
with `auto_send: true`). Review the draft in the Pingen dashboard first.

### Delivery products (Switzerland)

Pass `delivery_product` as e.g. `cheap` (B-Post), `fast` (A-Post),
`registered` (Einschreiben), `premium`. Exact availability depends on your
organisation/plan — check the Pingen dashboard.

## Install

```bash
git clone git@github.com:sapn95/pingen-mcp.git
cd pingen-mcp && npm install
claude mcp add --scope user pingen -- node /path/to/pingen-mcp/index.js
```

## Example

```
pingen_send_letter { "file_path": "/…/Einsprache_2024.pdf", "delivery_product": "registered", "address_position": "left" }
→ creates a draft; review in dashboard, then
pingen_submit_letter { "letter_id": "…", "delivery_product": "registered" }
```
