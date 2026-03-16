# 🤖 FB Listing Bot

Fully automated Facebook group posting using Playwright.

---

## Setup (One Time)

```bash
cd bot
npm install
npx playwright install chromium
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_KEY, CAMPAIGN_ID in .env
```

---

## Login — One Account

```bash
node login.js
# Browser opens → log in manually → session saved to fb_session.json
node bot.js
```

---

## Running Multiple Bots (Recommended for 60+ posts/day)

Each bot = one Facebook account = ~18 posts/day safely.
3 bots = ~54 posts/day. 4 bots = ~72 posts/day.

### Step 1 — Login each account separately

```bash
# Bot 1
SESSION_FILE=./fb_session_bot1.json node login.js

# Bot 2
SESSION_FILE=./fb_session_bot2.json node login.js

# Bot 3
SESSION_FILE=./fb_session_bot3.json node login.js
```

### Step 2 — Add bots in the Dashboard

Go to your web app → Dashboard → Bot Accounts → Add Bot.
Fill in the name and the session file name (e.g. fb_session_bot1.json).
Copy the Bot ID shown after saving.

### Step 3 — Run all bots in parallel (3 separate terminals)

```bash
# Terminal 1
SESSION_FILE=./fb_session_bot1.json BOT_ACCOUNT_ID=your-bot-1-id node bot.js

# Terminal 2
SESSION_FILE=./fb_session_bot2.json BOT_ACCOUNT_ID=your-bot-2-id node bot.js

# Terminal 3
SESSION_FILE=./fb_session_bot3.json BOT_ACCOUNT_ID=your-bot-3-id node bot.js
```

Each bot pulls the next pending item from the queue automatically.
They share the same campaign — no duplicate posts.

---

## .env Settings

| Variable | Default | Description |
|---|---|---|
| SUPABASE_URL | — | Your Supabase project URL |
| SUPABASE_KEY | — | Your Supabase anon key |
| CAMPAIGN_ID | — | Campaign ID from Dashboard |
| MIN_DELAY_SECONDS | 480 | Min 8 min between posts |
| MAX_DELAY_SECONDS | 900 | Max 15 min between posts |
| MAX_POSTS_PER_DAY | 18 | Hard daily cap per bot |
| POST_START_HOUR | 9 | Don't post before 9am |
| POST_END_HOUR | 20 | Don't post after 8pm |

---

## Session Expired?

Sessions last ~90 days. To renew:

```bash
SESSION_FILE=./fb_session_bot1.json node login.js
```
