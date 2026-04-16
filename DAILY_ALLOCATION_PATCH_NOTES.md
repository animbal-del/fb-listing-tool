# Daily Allocation Patch

This patch converts campaign creation from full pre-scheduling to daily assignment.

## Main behavior
- Campaign rows are inserted as pending and unassigned.
- When a bot is started on a campaign, the server allocates today's allowed share across all active bots already running that campaign.
- Each bot claims only rows assigned to its own `assigned_bot_id`.
- If a bot has no more assigned work for that campaign today, it ends cleanly so queue chaining can move it onward.

## Files changed
- `src/hooks/useCampaigns.js`
- `bot/server.js`
- `bot/bot.js`
- `supabase_schema.sql`
- `supabase_addons.sql`
- `supabase_migration.sql`
