-- Exact Online OAuth token row (single-tenant singleton: id must be 1)
-- Run in Supabase Dashboard → SQL Editor (or migrate via CI).

create table if not exists public.exact_oauth_session (
  id integer primary key,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  division text not null,
  updated_at timestamptz not null default now(),
  constraint exact_oauth_session_single_row check (id = 1)
);

comment on table public.exact_oauth_session is
  'Stores the active Exact OAuth session for id=1. Access only from backend using SUPABASE_SERVICE_ROLE_KEY.';

-- Block PostgREST access for browser keys; backend uses SUPABASE_SERVICE_ROLE_KEY only.
revoke all on table public.exact_oauth_session from anon, authenticated;
grant all on table public.exact_oauth_session to service_role;

alter table public.exact_oauth_session enable row level security;
