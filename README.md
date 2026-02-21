---
title: Frontend LLM Evaluator
emoji: "🧪"
colorFrom: blue
colorTo: indigo
sdk: docker
sdk_version: "latest"
app_file: app.py
app_port: 7860
hf_oauth: true
pinned: false
---

# Frontend LLM Evaluator

Next.js + shadcn dashboard to compare how different models redesign the same baseline landing page.

## Current capabilities

- Browse public generated artifacts in a shared model selector.
- Generate new artifacts by submitting:
  - Hugging Face API key (manual fallback)
  - Or Hugging Face OAuth session (stored in encrypted HttpOnly cookie)
  - Hugging Face model ID
  - Optional Hugging Face provider (or model suffix `:provider`)
  - Optional Hugging Face bill-to account (`X-HF-Bill-To`)
- Generate session outputs from proprietary providers with user-supplied API keys:
  - OpenAI
  - Anthropic
  - Google (Gemini)
- Call HF Inference Providers and persist generated HTML artifacts.
- Render artifacts inside a sandboxed iframe.
- Stream generation tokens into a live code view before switching to app preview.
- Compute per-generation USD cost from provider usage metadata and a local, versioned pricing table.

## Storage mode

- Without Supabase env vars: local filesystem fallback (`data/artifacts/*`).
- With Supabase env vars: shared storage mode for multi-user visibility.

## Supabase setup (shared mode)

1. Run SQL in `supabase/schema.sql`.
2. Create a storage bucket named `artifacts-html` (or set a custom name in env).
3. Configure env vars:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET_ARTIFACTS=artifacts-html
```

Optional:

```bash
HF_BASE_URL=https://router.huggingface.co/v1
GENERATION_TIMEOUT_MS=1200000
GENERATION_MAX_TOKENS=32768
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_VERSION=2023-06-01
GOOGLE_BASE_URL=https://generativelanguage.googleapis.com
HF_SESSION_COOKIE_SECRET=
HF_OAUTH_CLIENT_ID=
HF_OAUTH_CLIENT_SECRET=
HF_OAUTH_SCOPES=openid profile inference-api
HF_OAUTH_PROVIDER_URL=https://huggingface.co
HF_PUBLIC_ORIGIN=
```

`GENERATION_TIMEOUT_MS` is a total wall-clock budget for one `/api/generate/hf` request.
`GENERATION_MAX_TOKENS` sets the max output tokens requested from the provider.
If a provider is specified, generation attempts are:
1) `model:provider`
2) `model` (HF auto-routing fallback)

For serverless runtimes with hard function limits, set a lower timeout that fits your platform.

## Hugging Face OAuth setup

OAuth is supported in both Spaces and non-Space hosting.

### Spaces (`hf_oauth: true`)

Checklist:
1. Ensure `hf_oauth: true` is present in this `README.md` frontmatter.
2. In Space Settings, set `HF_SESSION_COOKIE_SECRET` (recommended, 32-byte base64/base64url secret).
3. Redeploy the Space after metadata/env changes.

With this enabled, Hugging Face injects:
   - `OAUTH_CLIENT_ID`
   - `OAUTH_CLIENT_SECRET`
   - `OAUTH_SCOPES`
   - `OPENID_PROVIDER_URL`
   - `SPACE_HOST`
Callback URL is `/oauth/callback` on your app domain. In Spaces, this app resolves the redirect origin from `SPACE_HOST` automatically. You can override with `HF_PUBLIC_ORIGIN` if needed.

If `HF_SESSION_COOKIE_SECRET` is not set, session-cookie encryption falls back to OAuth client-secret envs (`OAUTH_CLIENT_SECRET` in Spaces, `HF_OAUTH_CLIENT_SECRET` in custom deployments).

OAuth exchange method selection:
- `client_secret` when `OAUTH_CLIENT_SECRET` is available (Space-first default).
- `pkce` fallback when no client secret is present.

### Non-Space hosting

1. Create an OAuth app in Hugging Face connected applications.
2. Configure callback URL:
   - `https://<your-domain>/oauth/callback`
3. Set:
   - `HF_OAUTH_CLIENT_ID`
   - `HF_OAUTH_CLIENT_SECRET` (optional but recommended; enables `client_secret` exchange)
   - `HF_OAUTH_SCOPES` (must include `inference-api`)
   - `HF_OAUTH_PROVIDER_URL` (usually `https://huggingface.co`)
   - `HF_SESSION_COOKIE_SECRET`

### Security note

OAuth access tokens are stored in an encrypted HttpOnly cookie, not `localStorage`.
This reduces exposure to client-side script access and XSS token theft.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy to Hugging Face Spaces (Docker)

This repo now includes:
- `Dockerfile` (production build + runtime)
- `.dockerignore`

Container runtime defaults:
- listens on `0.0.0.0:7860`
- uses `npm run start -- -H 0.0.0.0 -p 7860`

For a Docker Space, set Space metadata to:

```yaml
sdk: docker
app_port: 7860
```

If you create the Space from this repo, add required secrets/variables in Space Settings (for example `HF_SESSION_COOKIE_SECRET`, OAuth vars, HF/Supabase vars as needed).

## Quality checks

```bash
npm run lint
npm test
npm run build
```

## Generation cost tracking

- Cost is computed only when both are available:
  - provider token usage metadata
  - a matching model entry in `lib/pricing.ts`
- If usage or pricing is missing, the UI shows `N/A`.
- Pricing values are pinned in-repo and versioned via `PRICING_VERSION` in `lib/pricing.ts`.
- Refresh `lib/pricing.ts` whenever provider pricing changes.

## API endpoints

### `GET /api/artifacts`
List public artifacts.

### `GET /api/artifacts?modelId=<id>`
Fetch one artifact HTML + metadata.

### `POST /api/artifacts`
Manual ingestion endpoint.

```json
{
  "modelId": "my-agent",
  "label": "My Agent",
  "promptVersion": "v1",
  "sourceType": "agent",
  "html": "<html>...</html>",
  "sourceRef": "optional-run-reference"
}
```

### `POST /api/generate/hf`
Generate and publish from Hugging Face provider model.

### `POST /api/generate`
Unified non-stream generation endpoint for:
- `huggingface`
- `openai`
- `anthropic`
- `google`

Example payloads:

```json
{
  "provider": "openai",
  "openaiApiKey": "sk_...",
  "modelId": "gpt-4.1"
}
```

```json
{
  "provider": "anthropic",
  "anthropicApiKey": "sk-ant-...",
  "modelId": "claude-3-7-sonnet-latest"
}
```

```json
{
  "provider": "google",
  "googleApiKey": "AIza...",
  "modelId": "gemini-2.5-flash"
}
```

For Hugging Face through the unified route:

```json
{
  "provider": "huggingface",
  "hfApiKey": "hf_...",
  "modelId": "moonshotai/Kimi-K2-Instruct-0905",
  "providerCandidates": ["novita", "nebius"],
  "billTo": "huggingface"
}
```

Auth options:
- Send `hfApiKey` in request body, or
- Omit `hfApiKey` and use a valid Hugging Face OAuth session cookie.

```json
{
  "hfApiKey": "hf_...",
  "modelId": "moonshotai/Kimi-K2-Instruct-0905"
}
```

You can optionally pass an explicit provider:

```json
{
  "hfApiKey": "hf_...",
  "modelId": "moonshotai/Kimi-K2-Instruct-0905",
  "provider": "novita"
}
```

You can also pass a bill-to account header value:

```json
{
  "hfApiKey": "hf_...",
  "modelId": "moonshotai/Kimi-K2-Instruct-0905",
  "billTo": "huggingface"
}
```

Or pass the provider directly in the model value:
`MiniMaxAI/MiniMax-M2.5:novita`.

### `POST /api/generate/hf/stream`
Streaming generation endpoint (`text/event-stream`) used by the dashboard UI.

### `POST /api/generate/stream`
Unified streaming generation endpoint (`text/event-stream`) used by the dashboard UI for all providers.

Request payload:

```json
{
  "provider": "openai",
  "openaiApiKey": "sk_...",
  "modelId": "gpt-4.1"
}
```

Request payload:

```json
{
  "hfApiKey": "hf_...",
  "modelId": "moonshotai/Kimi-K2-Instruct-0905",
  "provider": "novita"
}
```

Emits events:
- `meta`
- `attempt`
- `token`
- `log`
- `complete`
- `error`
- `done`

`/api/generate/hf` and `/api/generate/hf/stream` remain available for Hugging Face compatibility.

### `GET /api/auth/hf/config`
Returns public OAuth config for the frontend:

```json
{
  "enabled": true,
  "mode": "space",
  "exchangeMethod": "client_secret",
  "clientId": "hf_...",
  "scopes": ["openid", "profile", "inference-api"],
  "providerUrl": "https://huggingface.co",
  "redirectUrl": "http://localhost:3000/oauth/callback"
}
```

### `GET /api/auth/hf/session`
Returns OAuth session status:

```json
{
  "connected": true,
  "expiresAt": 1770000000
}
```

### `POST /api/auth/hf/session`
Stores OAuth access token in encrypted HttpOnly cookie.

```json
{
  "accessToken": "hf_oauth_token",
  "expiresAt": 1770000000
}
```

### `DELETE /api/auth/hf/session`
Clears OAuth session cookie.

## OAuth troubleshooting

1. Check deployment metadata:
   - `hf_oauth: true` in README frontmatter.
2. Check Space runtime env injection:
   - `OAUTH_CLIENT_ID`
   - `OAUTH_CLIENT_SECRET`
   - `OAUTH_SCOPES`
   - `OPENID_PROVIDER_URL`
   - `SPACE_HOST`
3. Check app config endpoint:
   - `GET /api/auth/hf/config` should return:
     - `enabled: true`
     - `mode: "space"`
     - `exchangeMethod: "client_secret"` (or `pkce` fallback if no secret)
4. Check required app secret:
   - `HF_SESSION_COOKIE_SECRET` must be set (32-byte base64/base64url).
5. If callback fails:
   - Inspect `POST /api/auth/hf/exchange` JSON response `error`.
   - The UI shows sanitized provider/server detail when available.
