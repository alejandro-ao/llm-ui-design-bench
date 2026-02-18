# Frontend LLM Evaluator

Next.js + shadcn dashboard to compare how different models redesign the same baseline landing page.

## Current capabilities

- Browse public generated artifacts in a shared model selector.
- Generate new artifacts by submitting:
  - Hugging Face API key (used only for that request)
  - Hugging Face model ID
- Call HF Inference Providers and persist generated HTML artifacts.
- Render artifacts inside a sandboxed iframe.

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
HF_BASE_URL=https://router.huggingface.co/v1/chat/completions
GENERATION_TIMEOUT_MS=60000
```

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
