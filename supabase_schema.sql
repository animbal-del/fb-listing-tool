-- ============================================================
-- Facebook Group Listing Poster — Supabase Schema v2
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- 1. PROPERTIES
create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  rent integer,
  deposit integer,
  locality text,
  phone text,
  whatsapp_link text,
  photos text[] default '{}',
  status text default 'available' check (status in ('available', 'rented')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. GROUPS
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fb_url text not null,
  locality_tag text,
  member_count integer,
  active boolean default true,
  created_at timestamptz default now()
);

-- 3. CAMPAIGNS
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text default 'active' check (status in ('active', 'paused', 'completed')),
  notes text,
  total_posts integer default 0,
  posts_per_day_limit integer default 18,
  posting_start_hour integer default 9,
  posting_end_hour integer default 20,
  jitter_enabled boolean default false
);

-- 4. POST QUEUE
create table if not exists post_queue (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,
  group_id uuid references groups(id) on delete cascade,
  assigned_bot_id uuid,  -- which bot account is handling this item
  scheduled_at timestamptz,
  status text default 'pending' check (status in ('pending', 'posted', 'skipped', 'failed')),
  posted_at timestamptz,
  error_log text,
  duplicate_warned boolean default false,
  created_at timestamptz default now()
);

-- 5. BOT ACCOUNTS (NEW)
create table if not exists bot_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,                          -- e.g. "Bot 1 - Rohit"
  fb_email text,
  fb_password text,                            -- stored for automated login
  session_file text,                           -- filename e.g. fb_session_bot1.json
  status text default 'idle' check (status in ('idle', 'running', 'paused', 'error')),
  last_active timestamptz,
  posts_today integer default 0,
  posts_today_date date default current_date,
  total_posts integer default 0,
  active boolean default true,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_post_queue_status     on post_queue(status);
create index if not exists idx_post_queue_scheduled  on post_queue(scheduled_at);
create index if not exists idx_post_queue_campaign   on post_queue(campaign_id);
create index if not exists idx_post_queue_bot        on post_queue(assigned_bot_id);
create index if not exists idx_properties_status     on properties(status);
create index if not exists idx_groups_active         on groups(active);

-- ============================================================
-- AUTO-UPDATE updated_at on properties
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_properties_updated_at on properties;
create trigger trg_properties_updated_at
  before update on properties
  for each row execute function update_updated_at();

-- ============================================================
-- RLS — open to all (anon + authenticated)
-- ============================================================
alter table properties   enable row level security;
alter table groups       enable row level security;
alter table campaigns    enable row level security;
alter table post_queue   enable row level security;
alter table bot_accounts enable row level security;

drop policy if exists "all_properties"   on properties;
drop policy if exists "all_groups"       on groups;
drop policy if exists "all_campaigns"    on campaigns;
drop policy if exists "all_post_queue"   on post_queue;
drop policy if exists "all_bot_accounts" on bot_accounts;

create policy "all_properties"   on properties   for all using (true) with check (true);
create policy "all_groups"       on groups       for all using (true) with check (true);
create policy "all_campaigns"    on campaigns    for all using (true) with check (true);
create policy "all_post_queue"   on post_queue   for all using (true) with check (true);
create policy "all_bot_accounts" on bot_accounts for all using (true) with check (true);

-- ============================================================
-- DUPLICATE CHECK HELPER
-- ============================================================
create or replace function check_duplicate_post(
  p_property_id uuid, p_group_id uuid, p_days integer default 14
) returns boolean as $$
begin
  return exists (
    select 1 from post_queue
    where property_id = p_property_id and group_id = p_group_id
      and status = 'posted' and posted_at > now() - (p_days || ' days')::interval
  );
end;
$$ language plpgsql;

-- ============================================================
-- MIGRATION — run this if you already have bot_accounts table
-- (safe to run even if column already exists)
-- ============================================================
alter table bot_accounts add column if not exists fb_password text;
