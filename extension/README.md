# Chrome Extension — Install & Setup

## Install (Developer Mode)
1. Open Chrome → `chrome://extensions`
2. Toggle **Developer Mode** ON (top right)
3. Click **Load Unpacked** → select the `extension/` folder
4. The 🏠 icon appears in your Chrome toolbar

## First-Time Setup
Click the extension icon → fill in:
- **Supabase URL** — from your Supabase Dashboard → Project Settings → API
- **Anon Key** — same location
- **Campaign ID** — copy from the web app Dashboard after launching a campaign

## How Posting Works
1. Launch a campaign in the web app
2. Paste the Campaign ID into the extension popup
3. The extension polls every 60 seconds for the next due queue item
4. When a post is due, it opens the Facebook group in a new tab
5. The overlay appears in the bottom-right of the page
6. Text is auto-filled in the composer
7. Click **Post Now** → extension clicks Facebook's Post button and logs the result
8. Tab closes automatically after 6 seconds
9. Extension waits a randomised interval (8–22 min) then opens the next group

## Anti-Bot Rules (built in)
- Max 18 posts/day (configurable)
- Posts only between 9:00–20:00 (configurable in campaign settings)
- 8–22 minute random gap between posts
- Auto session break (2–3 hours) after 8 consecutive posts

## Troubleshooting
| Problem | Fix |
|---------|-----|
| Text not auto-filled | Facebook changed their DOM — paste manually (text is in clipboard), then click Post Now |
| Post button not found | Click the Facebook Post button manually after text is filled |
| Extension not opening tabs | Check permissions in chrome://extensions — ensure "Allow on all sites" is enabled |
| Campaign not loading | Verify Campaign ID is correct and campaign status is "active" |
