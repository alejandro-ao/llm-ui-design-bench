# Frontend LLM Evaluator

A Next.js + shadcn-based app to compare how different LLMs (and later agents) redesign the same baseline landing page.

## What it does

- Shows a curated dropdown of model outputs.
- Uses one shared prompt for all models.
- Renders each model artifact in a sandboxed iframe.
- Stores artifacts in-repo under `data/artifacts/`.
- Provides `POST /api/artifacts` for future agent/model ingestion.

## Project layout

- `baseline/`: original bad design input.
- `data/artifacts/manifest.json`: available artifact registry.
- `data/artifacts/<model-id>/index.html`: generated model/agent output.
- `app/api/artifacts/route.ts`: list/detail/ingest API.

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

## Ingest a new artifact

`POST /api/artifacts` with JSON:

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
