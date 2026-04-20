Dynamic Dispatch Patch

What changed:
- Campaign creation no longer pre-schedules every queue row.
- Bots claim the next available pending task live.
- Campaign daily caps are enforced at claim time.
- Bots pace themselves using bot delays and session breaks.
- When a campaign hits its daily cap, the bot exits that campaign run cleanly so server queue chaining can start the next campaign.
- New bots added later in the day can immediately help on the remaining work because tasks are not pre-assigned or time-locked.

Files changed:
- src/hooks/useCampaigns.js
- bot/server.js
- bot/bot.js
- supabase_migration.sql
