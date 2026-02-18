create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  model_id text not null,
  label text not null,
  provider text,
  vendor text,
  source_type text not null check (source_type in ('model', 'agent', 'baseline')),
  prompt_version text not null,
  source_ref text,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists artifacts_model_id_unique_idx on public.artifacts (model_id);
create index if not exists artifacts_created_at_idx on public.artifacts (created_at desc);

-- Create storage bucket manually in Supabase dashboard:
-- name: artifacts-html
