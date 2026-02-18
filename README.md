# Frontend LLM Evaluator

Next.js + shadcn dashboard to compare how different models redesign the same baseline landing page.

## Current capabilities

- Browse public generated artifacts in a shared model selector.
- Generate new artifacts by submitting:
  - Hugging Face API key (used only for that request)
  - Hugging Face model ID
  - Optional Hugging Face provider (or model suffix `:provider`)
  - Optional Hugging Face bill-to account (`X-HF-Bill-To`)
- Call HF Inference Providers and persist generated HTML artifacts.
- Render artifacts inside a sandboxed iframe.
- Stream generation tokens into a live code view before switching to app preview.

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
```

`GENERATION_TIMEOUT_MS` is a total wall-clock budget for one `/api/generate/hf` request.
`GENERATION_MAX_TOKENS` sets the max output tokens requested from the provider.
If a provider is specified, generation attempts are:
1) `model:provider`
2) `model` (HF auto-routing fallback)

For serverless runtimes with hard function limits, set a lower timeout that fits your platform.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Quality checks

```bash
npm run lint
npm test
npm run build
```

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
