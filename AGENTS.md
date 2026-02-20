# Repository Guidelines

## Project Structure & Module Organization
- `app/`: Next.js App Router entrypoints, pages, and API routes (for example `app/api/generate/hf/route.ts`).
- `components/`: Reusable UI and feature components; tests are often colocated (for example `components/evaluator-client.test.tsx`).
- `lib/`: Core utilities and integration logic (HF auth, artifact storage, model helpers), with unit tests.
- `data/artifacts/`: Local artifact storage (`manifest.json` plus generated `index.html` files) used when Supabase is not configured.
- `public/`: Static assets and favicons.
- `supabase/schema.sql`: Database schema for shared artifact mode.

## Build, Test, and Development Commands
- `npm install`: Install dependencies.
- `npm run dev`: Start local dev server at `http://localhost:3000`.
- `npm run lint`: Run ESLint (`eslint.config.mjs`) across the repo.
- `npm test`: Run all tests once with Vitest.
- `npm run test:watch`: Run Vitest in watch mode for local iteration.
- `npm run build`: Production build check (must pass before merging).
- `npm run start`: Run the built app (used in Docker/prod-like validation).

## Coding Style & Naming Conventions
- Language: TypeScript (`strict: true` in `tsconfig.json`), React 19, Next.js 16.
- Follow existing style: 2-space indentation, semicolons, double quotes, trailing commas.
- Use the `@/` path alias for root imports (configured in `tsconfig.json` and `vitest.config.ts`).
- Components use PascalCase exports; filenames are typically kebab-case (for example `model-selector.tsx`).
- Keep route handlers in `app/api/**/route.ts`; keep related tests adjacent as `route.test.ts`.

## Testing Guidelines
- Framework: Vitest + Testing Library (`jsdom` env configured in `vitest.config.ts`).
- Test patterns: `**/*.test.ts` and `**/*.test.tsx`.
- Prefer fast, isolated tests for `lib/` and API routes; add UI behavior tests for component state changes.
- Use node-only tests when needed via `// @vitest-environment node`.
- Run `npm run lint && npm test && npm run build` before opening a PR.

## Commit & Pull Request Guidelines
- Recent history favors short, imperative commits, usually with prefixes like `fix:`, `feat:`, `chore:`, `build:`.
- Keep commits focused; avoid `wip` commits on shared branches.
- PRs should include:
  - What changed and why.
  - Test evidence (command output summary).
  - Screenshots/GIFs for UI changes.
  - Notes for env or schema updates (`.env.example`, `supabase/schema.sql`).

## Security & Configuration Tips
- Copy `.env.example` for local setup; never commit API keys or OAuth secrets.
- Set `HF_SESSION_COOKIE_SECRET` in any deployed environment to protect OAuth session cookies.
