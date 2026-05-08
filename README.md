# FB Listing Tool — Denner's

Automated Facebook group property listing system. The frontend lets you manage listings, Facebook groups, and campaigns. The bot server (running on a Hostinger VPS via Docker) picks up queued posts and publishes them to Facebook groups automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend  (React + Vite — deployed on Vercel)          │
│  • Properties  → reads/writes Denner's Supabase         │
│  • Groups, Campaigns, Queue → reads/writes Own Supabase │
│  • Bot dashboard → talks to Bot API via HTTPS           │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS (bot.denner.in)
┌──────────────────────▼──────────────────────────────────┐
│  Bot Server  (Node.js + Playwright — Hostinger VPS)     │
│  • Exposes REST API for start / stop / logs             │
│  • Spawns bot processes that post to Facebook           │
│  • Reads post queue from Own Supabase                   │
│  • Reads property data from Denner's Supabase           │
└─────────────────────────────────────────────────────────┘

Own Supabase          Denner's Supabase (Inventory Tool)
─────────────         ──────────────────────────────────
campaigns             inventory_flats
post_queue            inventory_flat_media
groups                inventory_flat_intake
bot_accounts
```

---

## Project Structure

```
fb-listing-tool/
├── src/
│   ├── lib/
│   │   ├── supabase.js          # Own Supabase client (campaigns/groups/bots)
│   │   ├── dennerSupabase.js    # Denner's Supabase client (inventory)
│   │   ├── storage.js           # Photo upload → Denner's storage bucket
│   │   └── AuthContext.jsx      # Auth state
│   ├── hooks/
│   │   ├── useProperties.js     # CRUD → inventory_flats + media + intake
│   │   ├── useCampaigns.js      # CRUD → campaigns + post_queue (cross-DB join)
│   │   └── useGroups.js         # CRUD → groups
│   ├── components/
│   │   ├── PropertyForm.jsx     # Add / edit listing form
│   │   ├── Layout.jsx           # Sidebar nav shell
│   │   └── Modal.jsx            # Reusable modal
│   └── pages/
│       ├── PropertiesPage.jsx   # Listing manager (add, edit, CSV import)
│       ├── DashboardPage.jsx    # Campaign status + bot controls
│       ├── CampaignPage.jsx     # Campaign builder (multi-step)
│       ├── GroupsPage.jsx       # FB group manager
│       └── LoginPage.jsx        # Auth screen
├── bot/
│   ├── bot.js                   # Core Playwright posting bot
│   ├── server.js                # REST API wrapping bot processes
│   ├── Dockerfile               # Bot container image
│   ├── docker-compose.bot.yml   # VPS deployment config (bot.denner.in)
│   └── .env.example             # Bot environment variable template
├── supabase_schema.sql          # Own Supabase schema (run once)
├── supabase_migration.sql       # Own Supabase migrations (run once)
├── migration_post_queue_property_id.sql  # Run if migrating from old schema
├── .env.example                 # Frontend environment variable template
└── vercel.json                  # Vercel routing config
```

---

## Databases

This project uses **two separate Supabase projects**:

| | Own Supabase | Denner's Supabase |
|---|---|---|
| **Purpose** | Campaigns, queues, groups, bot accounts | Property inventory (inventory_flats, media, intake) |
| **Env vars** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | `VITE_DENNER_SUPABASE_URL` / `VITE_DENNER_SUPABASE_ANON_KEY` |
| **Storage** | — | `VITE_DENNER_STORAGE_BUCKET` (flat photos) |

---

## Frontend Setup (Local Development)

### 1. Clone the repo

```bash
git clone https://github.com/animbal-del/fb-listing-tool.git
cd fb-listing-tool
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cat .env.example
```

```
# Own Supabase (campaigns, post_queue, groups, bot_accounts)
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here

# Denner's Inventory Management Supabase
VITE_DENNER_SUPABASE_URL=https://DENNER_PROJECT_ID.supabase.co
VITE_DENNER_SUPABASE_ANON_KEY=denner_anon_key_here

# Storage bucket used by inventory_flat_media in Denner's system
VITE_DENNER_STORAGE_BUCKET=flat-media
```

```bash
cp .env.example .env.local
# Fill in all six values
```

### 4. Set up Own Supabase (first time only)

1. Open your Supabase SQL Editor
2. Run `supabase_schema.sql` — creates `campaigns`, `post_queue`, `groups`, `bot_accounts`
3. Run `supabase_migration.sql` — adds indexes and the `claim_next_post_queue_item` function
4. If migrating from old schema: run `migration_post_queue_property_id.sql`
5. Go to **Authentication → Users → Add User** — create your login account

### 5. Run locally

```bash
npm run dev
```

Open http://localhost:5173 and sign in.

---

## Frontend Deployment (Vercel)

```bash
npm install -g vercel
vercel
```

Add all six environment variables in **Vercel Dashboard → Project → Settings → Environment Variables**.

---

## Pulling Updates (Existing Installation)

```bash
git pull origin main
npm install          # in case new packages were added
```

Then redeploy on Vercel (auto-deploys on push if connected to GitHub).

---

## How Campaigns Work

1. **Add properties** in the Properties tab (synced with Denner's inventory)
2. **Add Facebook groups** in the Groups tab
3. **Build a campaign** — select listings × groups → generates a post queue
4. **Start a bot** in the Dashboard → assign it a campaign
5. The bot claims queue items one by one, opens each Facebook group, and posts the listing with photos
6. Campaign is marked **completed** only when all posts are `posted` or `skipped` — failed posts keep the campaign **active** so you can retry them

---

## Property Description Template Variables

In the Description field you can use these placeholders — the bot substitutes them at post time:

| Variable | Replaced with |
|---|---|
| `{phone}` | Owner phone number |
| `{whatsapp_link}` | WhatsApp number |
| `{locality}` | Locality |
| `{rent}` | Monthly rent (formatted ₹) |
| `{deposit}` | Deposit amount (formatted ₹) |

---

## CSV Import Format

Download the sample CSV from the Properties page for the exact format. Required columns:

```
title, description, bhk, city, society_name, rent, deposit, locality, phone, whatsapp_link, status
```

`status` must be `available` or `rented`. Missing `bhk` defaults to `1BHK`, missing `city` defaults to `Unknown`.
