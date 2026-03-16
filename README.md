# 🏠 Facebook Group Listing Poster — MVP

## Day 1 Setup (Do this now)

### Step 1 — Supabase Schema
1. Open your Supabase project → SQL Editor
2. Paste the entire contents of `supabase_schema.sql` and click Run
3. Go to Storage → New Bucket → Name: `property-photos` → Toggle Public ON → Create

### Step 2 — Supabase Auth User
1. Supabase Dashboard → Authentication → Users → Add User
2. Enter your email + password (this is your login to the app)

### Step 3 — Environment Variables
```bash
cp .env.example .env.local
```
Edit `.env.local` and fill in:
- `VITE_SUPABASE_URL` — from Project Settings → API → Project URL
- `VITE_SUPABASE_ANON_KEY` — from Project Settings → API → anon/public key

### Step 4 — Run the App
```bash
npm install
npm run dev
```
Open http://localhost:5173 — you should see the login screen.

Sign in with the user you created in Step 2.

---

## Project Structure

```
src/
  lib/
    supabase.js        # Supabase client
    AuthContext.jsx    # Auth state + hooks
  components/
    Layout.jsx         # Sidebar nav shell
  pages/
    LoginPage.jsx      # Auth screen
    PropertiesPage.jsx # Day 2 — property CRUD
    PlaceholderPages   # Days 3–5 stubs
  App.jsx              # Router + auth guard
  main.jsx             # Entry point
  index.css            # Global styles + Tailwind

supabase_schema.sql    # Run once in Supabase SQL Editor
.env.example           # Copy to .env.local
```

---

## Build Schedule

| Day | What Gets Built |
|-----|----------------|
| ✅ Day 1 | Supabase schema + React scaffold + Auth |
| Day 2 | Property Manager — CRUD, photos, status toggle |
| Day 3 | Group Manager + Campaign Builder + queue preview |
| Day 4 | Chrome Extension — queue polling + Facebook posting |
| Day 5 | Scheduler logic + Dashboard + end-to-end test |

---

## Deploy to Vercel (when ready)
```bash
npm install -g vercel
vercel
```
Add your two env vars in Vercel dashboard → Project → Settings → Environment Variables.
