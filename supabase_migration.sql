-- ============================================================
-- MIGRATION v3 — Run this in Supabase SQL Editor
-- Safe to run multiple times
-- ============================================================

-- 1. Create bot_accounts table (main fix)
create table if not exists bot_accounts (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  fb_email            text not null,
  fb_password         text not null,
  session_file        text,
  status              text default 'idle' check (status in ('idle','running','paused','error','logging_in')),
  last_active         timestamptz,
  posts_today         integer default 0,
  posts_today_date    date default current_date,
  total_posts         integer default 0,
  active              boolean default true,
  -- Bot behaviour settings (editable from dashboard)
  min_delay_seconds   integer default 480,
  max_delay_seconds   integer default 900,
  max_posts_per_day   integer default 18,
  post_start_hour     integer default 9,
  post_end_hour       integer default 20,
  session_cap         integer default 8,
  session_break_min   integer default 120,
  session_break_max   integer default 180,
  created_at          timestamptz default now()
);

-- 2. Add new settings columns if table already exists
alter table bot_accounts add column if not exists min_delay_seconds  integer default 480;
alter table bot_accounts add column if not exists max_delay_seconds  integer default 900;
alter table bot_accounts add column if not exists max_posts_per_day  integer default 18;
alter table bot_accounts add column if not exists post_start_hour    integer default 9;
alter table bot_accounts add column if not exists post_end_hour      integer default 20;
alter table bot_accounts add column if not exists session_cap        integer default 8;
alter table bot_accounts add column if not exists session_break_min  integer default 120;
alter table bot_accounts add column if not exists session_break_max  integer default 180;

-- 3. Add assigned_bot_id to post_queue if missing
alter table post_queue add column if not exists assigned_bot_id uuid;

-- 4. RLS — open access for everything
alter table bot_accounts enable row level security;

drop policy if exists "all_bot_accounts"  on bot_accounts;
drop policy if exists "all_campaigns"     on campaigns;
drop policy if exists "all_post_queue"    on post_queue;
drop policy if exists "all_properties"    on properties;
drop policy if exists "all_groups"        on groups;

create policy "all_bot_accounts" on bot_accounts  for all using (true) with check (true);
create policy "all_campaigns"    on campaigns      for all using (true) with check (true);
create policy "all_post_queue"   on post_queue     for all using (true) with check (true);
create policy "all_properties"   on properties     for all using (true) with check (true);
create policy "all_groups"       on groups         for all using (true) with check (true);

-- Done
select 'Migration v3 complete ✅' as result;
