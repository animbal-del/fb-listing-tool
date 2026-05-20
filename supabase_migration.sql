-- ============================================================
-- DAILY DISPATCH MIGRATION
-- Dynamic campaign quota + bot-paced dispatch
-- No pre-scheduled per-row timings required
-- ============================================================

-- 1. Ensure helper columns exist
alter table public.post_queue add column if not exists assigned_bot_id uuid;
alter table public.post_queue add column if not exists claimed_at timestamptz;
alter table public.post_queue add column if not exists post_url text;

-- 2. Useful indexes
create index if not exists idx_post_queue_campaign_status_created
  on public.post_queue(campaign_id, status, created_at);

create index if not exists idx_post_queue_claimed_at
  on public.post_queue(claimed_at);

create index if not exists idx_post_queue_posted_at
  on public.post_queue(posted_at);

create index if not exists idx_post_queue_assigned_bot
  on public.post_queue(assigned_bot_id);

-- 3. Dynamic claim function
drop function if exists public.claim_next_post_queue_item(uuid, uuid);
drop function if exists public.claim_next_post_queue_item(uuid, uuid, timestamptz, timestamptz);

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

  with next_item as (
    select q.id
    from public.post_queue q
    where q.campaign_id = p_campaign_id
      and q.status = 'pending'
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

select 'Dynamic dispatch migration complete ✅' as result;
