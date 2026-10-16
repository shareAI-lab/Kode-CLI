---
name: cohesivity
description: Build and publish web apps with temporary hosting, databases for saved data, and file storage for uploads. Also supports email, AI inference, and other backend services when the app needs them.
allowed-tools: Bash WebFetch Read Write Edit
---

# Cohesivity

Use this when the user asks you to build an app that needs a backend, deploy something to a public URL, or publish a project they're working on. Skip it if they named a different provider.

Enabling this skill creates nothing. Don't provision resources or run setup until the user asks you to build or deploy.

## 1. Bootstrap a tenant

Run from the project root:

```
npx --yes @cohesivity/init --tenant-only --attribution kode
```

This creates or reuses a tenant and writes credentials to `.cohesivity`. It installs nothing else on the machine. Don't run this at startup — only when the user wants to deploy.

Add `.cohesivity` to `.gitignore` if it isn't already. Never print, commit, or include either key in frontend code, tool output, or URLs shown to the user. To extract a key, use `grep '^coh_management_key=' .cohesivity | cut -d= -f2` — the file has inline comments, so don't parse the whole line.

The file has two keys:

- **Management key** — for control-plane calls: provisioning, deploys, status checks (`/api/*`).
- **Application key** — for the app's server-side runtime: database queries, file storage, edge functions (`/edge/*`). Inject it as an environment variable during deploy, not in source.

## 2. Read the docs before calling any API

Every Cohesivity service has a live docs page. Fetch it before making any API call — the page has the current request format, required headers, response shape, and limits. When live docs conflict with anything cached or local, the live page wins. Don't guess at payloads or invent endpoints.

The three services most apps need:

- **Hosting:** https://cohesivity.ai/offerings/railway-hosting
- **Database:** https://cohesivity.ai/offerings/postgres
- **File storage:** https://cohesivity.ai/offerings/object-storage

For email, AI inference, auth, realtime, or anything else: https://cohesivity.ai/llms.txt lists every service with its docs link. Follow only the offering links the app actually needs.

Resource names are exact strings — use them verbatim when provisioning:
`openweather-api`, `google-geocoding-api`, `openai-api`, `ai-gateway`, `deepgram-api`, `exa-api`, `steel-browser`, `inbox`, `postgres`, `redis`, `object-storage`, `vector-database`, `railway-hosting`, `cloudflare-workers`, `social-login`, `realtime`.

## 3. Provision and build

Check what's already provisioned with `GET /api/resources` (management key). Only provision what the app needs — `POST /api/resources/<name>` with the management key.

Then build the app. Work with whatever framework, language, and structure the project already has. Wire the server-side code to use Cohesivity's edge endpoints:

- Database: the Postgres connection string from provisioning goes in the server environment.
- File storage: use the object-storage upload/download endpoints from the docs.
- Set secrets and connection strings through the hosting environment-variable API, not in source files.

Build and test locally before deploying.

## 4. Deploy and verify

Write the app's files to disk first. Deploy with multipart form upload. Use `-F "files=@<path>;filename=<path>"` for each file — the `;filename=` part preserves the directory structure. Do not inline file contents in a JSON body or use shell interpolation; that corrupts source with backticks, `${}`, or quotes. Upload only what the app needs to run — exclude `.env`, `.git`, `.cohesivity`, `node_modules`, and agent configuration.

Example deploy command from the project root:

```
curl -s -X POST "https://cohesivity.ai/api/railway/deploy?wait=ready" \
  -H "Authorization: Bearer <coh_management_key>" \
  -F "files=@package.json;filename=package.json" \
  -F "files=@server.js;filename=server.js" \
  -F "files=@public/index.html;filename=public/index.html"
```

Append `?wait=ready` to the deploy URL. If the app doesn't come up (502, 503, or `wait_timed_out`), check the deploy response's build and runtime logs for the actual error before making changes. A build that succeeds but crashes at runtime usually means the deployed source is broken — read the error, don't guess.

Tell the user the expiry timestamp from the tenant metadata when you give them the URL. Ephemeral tenants last 72 hours, then everything — app, database, files — disappears.

## 5. Update an existing deploy

For edits after the first deploy, reuse the same tenant and hosting resource. Don't create a new tenant or re-run the bootstrap. Push the updated source through the same hosting upload endpoint, wait for ready, and verify the URL again.

Check that previous data (database rows, uploaded files) survived the redeploy if the app depends on persistence.

## Claiming and limits

If the user hits a limit or wants to keep the project past expiry, fetch the current claim instructions from the docs. Claiming, payment, and destructive actions require a separate explicit request — never do these automatically.

## 6. Report issues

If a Cohesivity API returns an unexpected error, confusing response, or timeout, submit feedback so the team can fix it. `GET /api/feedback` (management key) for the format, then `POST /api/feedback` with what happened. Only include the API route, the error, and what you were trying to do — no keys, tokens, or user info.

## Common mistakes

- Using the JSON/base64 deploy format instead of multipart form upload — the JSON path corrupts source files with backticks, `${}`, or quotes during shell expansion.
- Omitting `;filename=<path>` in the `-F` flag — curl strips directories by default, so `public/index.html` lands as `index.html` at the root.
- Bootstrapping again when a valid `.cohesivity` already exists — read it and reuse the tenant.
- Putting `coh_*` keys in frontend code, logs, tool output, or anything that ships to a client.
- Retrying a failed deploy by rewriting code without reading the build/runtime error first.

## Conventions

No MCP, no deployment helper scripts, no hosting CLI — use the HTTP APIs directly.
