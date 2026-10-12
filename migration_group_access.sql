-- ============================================================
-- Run this on the ORIGINAL Supabase (project nhrfgs…), not Denner's.
-- Group access tracking: which bot account can post in which group.
--
--   • groups.disabled_reason / disabled_at — set when the bot turns a group off
--     (e.g. 'sale_form_only': only a "Sell Something" form, no Discussion tab)
--   • bot_group_access — per bot + group: member / not_member / join_pending /
--     needs_manual_join / pending_limit, and until when the bot should skip it
--   • bot_accounts.status may now be 'needs_login' (Facebook logged the account out)
--   • claim_next_post_queue_item skips groups this bot can't post in right now,
--     and marks posts for turned-off groups as skipped
--
-- Safe to re-run.
-- ============================================================

-- 1. Why a group was turned off
alter table public.groups add column if not exists disabled_reason text;
alter table public.groups add column if not exists disabled_at timestamptz;

-- 2. Per-bot group access
create table if not exists public.bot_group_access (
  bot_account_id uuid not null references public.bot_accounts(id) on delete cascade,
  group_id       uuid not null references public.groups(id) on delete cascade,
  status         text not null check (status in ('member', 'not_member', 'join_pending', 'needs_manual_join', 'pending_limit')),
  retry_after    timestamptz,   -- bot skips this group's posts until then
  joined_at      timestamptz,   -- when the bot last clicked "Join group" (daily join cap)
  note           text,
  updated_at     timestamptz not null default now(),
  primary key (bot_account_id, group_id)
);

create index if not exists idx_bot_group_access_group on public.bot_group_access(group_id);

-- Dashboard reads it; only the bot (service role) writes it
alter table public.bot_group_access enable row level security;
drop policy if exists "read_bot_group_access" on public.bot_group_access;
create policy "read_bot_group_access" on public.bot_group_access for select using (true);
grant select on public.bot_group_access to anon, authenticated;

-- 3. Allow bot_accounts.status = 'needs_login'
do $$
declare c text;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bot_accounts'::regclass
       and con.contype = 'c'
       and att.attname = 'status'
  loop
    execute format('alter table public.bot_accounts drop constraint %I', c);
  end loop;
end $$;

alter table public.bot_accounts add constraint bot_accounts_status_check
  check (status in ('idle', 'running', 'paused', 'error', 'logging_in', 'needs_login'));

-- 4. Claim: skip turned-off groups and groups this bot can't post in yet
create or replace function public.claim_next_post_queue_item(
  p_campaign_id uuid,
  p_bot_id uuid default null::uuid,
  p_day_start timestamptz default null::timestamptz,
  p_day_end timestamptz default null::timestamptz
)
returns uuid
language plpgsql
as $function$
declare
  v_item_id uuid;
  v_daily_limit integer;
  v_posted_today integer;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  select c.posts_per_day_limit
    into v_daily_limit
  from public.campaigns c
  where c.id = p_campaign_id;

  v_day_start := coalesce(p_day_start, date_trunc('day', now()));
  v_day_end := coalesce(p_day_end, v_day_start + interval '1 day');

  select count(*)
    into v_posted_today
  from public.post_queue q
  where q.campaign_id = p_campaign_id
    and q.status = 'posted'
    and q.posted_at >= v_day_start
    and q.posted_at < v_day_end;

  if coalesce(v_daily_limit, 0) > 0 and v_posted_today >= v_daily_limit then
    return null;
  end if;

  -- Posts for groups that were turned off will never be posted
  update public.post_queue q
  set
    status = 'skipped',
    error_log = case
      when g.disabled_reason = 'sale_form_only' then 'Group turned off: only allows Sell forms (no Discussion tab)'
      else 'Group is turned off'
    end
  from public.groups g
  where g.id = q.group_id
    and q.campaign_id = p_campaign_id
    and q.status = 'pending'
    and g.active = false;

  with next_item as (
    select q.id
    from public.post_queue q
    where q.campaign_id = p_campaign_id
      and q.status = 'pending'
      and not exists (
        select 1
        from public.bot_group_access a
        where a.bot_account_id = p_bot_id
          and a.group_id = q.group_id
          and a.retry_after > now()
      )
    order by q.created_at asc, q.id asc
    for update skip locked
    limit 1
  )
  update public.post_queue q
  set
    status = 'processing',
    assigned_bot_id = coalesce(p_bot_id, q.assigned_bot_id),
    claimed_at = now()
  from next_item
  where q.id = next_item.id
  returning q.id into v_item_id;

  return v_item_id;
end;
$function$;

select 'Group access migration complete ✅' as result;
