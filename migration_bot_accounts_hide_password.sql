-- Make bot_accounts.fb_password write-only for browser clients (anon / authenticated).
-- The dashboard can still set a password on insert/update but can never read it back.
-- The bot server reads it with the service_role key (SUPABASE_SERVICE_KEY in bot/.env).
--
-- Run AFTER the bot server has SUPABASE_SERVICE_KEY set and the updated dashboard is deployed.
-- NOTE: columns added to bot_accounts later must be granted explicitly (re-run this file).

revoke select on public.bot_accounts from anon, authenticated;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'bot_accounts'
     and column_name <> 'fb_password';

  execute format('grant select (%s) on public.bot_accounts to anon, authenticated', cols);
end $$;

select 'bot_accounts.fb_password is now write-only for anon ✅' as result;
