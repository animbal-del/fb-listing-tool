-- Store the final Facebook post URL for successfully posted queue items.

alter table public.post_queue
  add column if not exists post_url text;

select 'post_queue.post_url added ✅' as result;
