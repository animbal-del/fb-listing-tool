# FB Listing Bot — VPS Deployment Guide

The bot server runs as a Docker container on a Hostinger VPS. It exposes a REST API at `bot.denner.in` (port 3001, proxied through Traefik with HTTPS). The frontend dashboard communicates with this API to start/stop bots and stream logs.

---

## How It Works

```
Dashboard (Vercel)
    │  HTTPS calls to bot.denner.in
    ▼
server.js  (REST API — port 3001)
    │  spawns / kills child processes
    ▼
bot.js  (one process per running bot)
    │  claims post_queue items    → Own Supabase
    │  reads property + photos    → Denner's Supabase
    │  opens Facebook group       → Playwright / Chromium
    └  posts listing + photos     → Facebook
```

Each bot process:
- Claims one queue item at a time using an atomic SQL function (no two bots post the same item)
- Respects per-bot and per-campaign daily caps and posting hour windows
- Downloads photos once at startup (`warmPhotoCache`), reuses them for the session
- Displays a live `MM:SS` countdown in Docker logs between posts
- Marks a campaign **completed** only when there are zero pending, processing, and failed items

---

## Environment Variables

```bash
cat .env.example
```

```
# Own Supabase (campaigns, post_queue, groups, bot_accounts)
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_KEY=your_anon_or_service_key_here

# Denner's Inventory Management Supabase
DENNER_SUPABASE_URL=https://DENNER_PROJECT_ID.supabase.co
DENNER_SUPABASE_KEY=denner_anon_key_here

PORT=3001
TRAINING_GROUP_URL=https://www.facebook.com/groups/740033105526357
TZ=Asia/Kolkata
```

Copy and fill in:

```bash
cp .env.example .env
nano .env   # or vim .env
```

---

## First-Time Setup on VPS

### 1. SSH into the VPS and clone the repo

```bash
git clone https://github.com/animbal-del/fb-listing-tool.git
cd fb-listing-tool/bot
```

### 2. Configure environment

```bash
cat .env.example
cp .env.example .env
nano .env
# Fill in SUPABASE_URL, SUPABASE_KEY, DENNER_SUPABASE_URL, DENNER_SUPABASE_KEY
```

### 3. Build and start the container

```bash
docker compose -f docker-compose.bot.yml build
docker compose -f docker-compose.bot.yml up -d
```

### 4. Verify it's running

```bash
docker ps
docker logs fb-bot-server --tail 50
```

The server is ready when you see `Bot API server running on port 3001`.

---

## Updating the Bot (After Code Changes)

SSH into the VPS, then:

```bash
cd fb-listing-tool/bot

# Pull latest code
git -C .. pull origin main

# Rebuild the image (required after any code change)
docker compose -f docker-compose.bot.yml build --no-cache

# Restart the container with the new image
docker compose -f docker-compose.bot.yml up -d

# Confirm it started cleanly
docker logs fb-bot-server --tail 30 --follow
```

> **Note:** `docker compose up -d` alone reuses the old image if the container is already running. Always run `build` first after a code change.

---

## Common Docker Commands

| Action | Command |
|---|---|
| Start container | `docker compose -f docker-compose.bot.yml up -d` |
| Stop container | `docker compose -f docker-compose.bot.yml down` |
| Rebuild image | `docker compose -f docker-compose.bot.yml build --no-cache` |
| Restart container | `docker compose -f docker-compose.bot.yml restart` |
| Tail live logs | `docker logs fb-bot-server -f` |
| Last 100 lines | `docker logs fb-bot-server --tail 100` |
| Open shell inside | `docker exec -it fb-bot-server bash` |
| Check status | `docker ps` |

---

## Reading the Logs

Countdown between posts appears as a single updating line (uses `\r`):
```
⏳ Time left before Session break: 07:45
```
Format is `MM:SS` for waits under an hour, `HH:MM:SS` for longer waits (e.g. waiting for the next day's posting window).

Failed posts show the exact step that failed:
```
❌ Composer did not open — "2BHK Bandra" → Pune Rentals Group
```

---

## Bot Accounts

Each bot account = one Facebook account. Add them via **Dashboard → Bot Accounts → Add Bot**.

| Bots | Posts/day (approx.) |
|---|---|
| 1 bot | ~18/day |
| 3 bots | ~54/day |
| 4 bots | ~72/day |
| 5 bots | ~90/day |

Bot settings (delays, caps, hours) are stored in the `bot_accounts` table and re-read every 5 loop iterations — no restart required for setting changes.

---

## Facebook Login (Remote Session)

Bot sessions are stored as Playwright persistent browser profiles on the VPS. To log in a bot:

1. Go to **Dashboard → Bot Accounts → Open Remote Login Session**
2. A noVNC browser session opens — log in to Facebook in that browser
3. The session is saved automatically to the container volume
4. Click **Start Posting** in the dashboard once logged in

Sessions last approximately 90 days. Re-login using the same button when a bot shows "Login Required".

---

## Campaign Completion Logic

A campaign is marked **completed** only when:
- Zero `pending` posts
- Zero `processing` posts
- Zero `failed` posts

If failed posts remain, the campaign stays **active** and the bot exits cleanly, leaving this message in the logs:

```
⚠️  No pending posts remain — 3 post(s) ended in failed status.
   Use "Retry Failed" in the dashboard to requeue them.
   Campaign left active so you can retry without losing progress.
```

Use **Dashboard → Campaign → Retry Failed** to requeue them, then start the bot again.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Container won't start | `docker logs fb-bot-server --tail 50` — usually a missing env var |
| Bot stuck at "No due items" | Campaign may have only failed items — use Retry Failed |
| "Not logged in" on start | Re-login via Dashboard → Bot Accounts → Open Remote Login Session |
| Photos not attaching | Check `DENNER_SUPABASE_URL` and `DENNER_SUPABASE_KEY` are set in `.env` |
| API not reachable | Confirm Traefik is running: `docker ps | grep traefik` |
