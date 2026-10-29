-- Per-campaign post counts for the dashboard (instead of downloading every post).
-- Run once in the Supabase SQL editor of the FB tool project.
create or replace function public.campaign_post_stats()
returns table (campaign_id uuid, status text, n bigint)
language sql
stable
as $$
  select campaign_id, status::text, count(*)
  from public.post_queue
  group by campaign_id, status
$$;

grant execute on function public.campaign_post_stats() to anon, authenticated;
