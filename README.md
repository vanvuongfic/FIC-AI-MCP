# FIC AI TEST MCP

Private read-only MCP bridge for the FIC POS TEST diagnostics API.

It exposes exactly six tools: `health`, `runtime`, `latest_errors`, `tables`, `schema`, and `rows`.

The upstream is fixed to TEST: `https://win-house.timxe247.com`. There is no Production URL, shell, SSH, write endpoint, database mutation, or .env reader.

## Required environment variables

- `FIC_AI_SECRET` — existing TEST REST API secret. Never commit it.
- `MCP_CLIENT_TOKEN` — a separate strong bearer token used by ChatGPT/plugin clients. Never reuse `FIC_AI_SECRET`.
- `MCP_ALLOWED_HOST` — public MCP hostname, without scheme/path.
- `MCP_HOST` — optional bind address; defaults to `0.0.0.0`.
- `PORT` — optional; defaults to `3000`.

The table allowlist is fetched from the protected TEST `/tables` endpoint, so there is no duplicated table list in MCP configuration. `rows` maps only the REST API's supported `columns[]`, `where[...]`, and `limit` parameters.

## Run

Use Node.js 20+.

```bash
npm install --omit=dev
npm start
```

Put the service behind HTTPS. Configure secrets only in the deployment platform's secret/environment manager. Do not put secrets in GitHub, plugin source, mcp.json, command history, screenshots, or chat.

MCP endpoint: `https://YOUR-MCP-HOST/mcp`

Health endpoint for deployment checks: `https://YOUR-MCP-HOST/healthz`

The MCP client must send `Authorization: Bearer <MCP_CLIENT_TOKEN>`.

## Security

The bridge performs GET requests only. The Laravel TEST API remains the authority for allowed tables, sensitive columns, validation, and read-only behavior. Returned JSON is scrubbed again by the MCP bridge as defense in depth.
