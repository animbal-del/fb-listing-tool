// bot.js — FB Group Posting Bot
// Bot timing = execution behavior
// Campaign timing = campaign-level constraint
// Effective runtime uses Option C:
//   daily cap   = min(bot max/day, campaign posts/day)
//   start hour  = max(bot start, campaign start)
//   end hour    = min(bot end, campaign end)

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'
import { cleanPostText } from './postText.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const SESSION_FILE    = process.env.SESSION_FILE    || join(__dir, 'fb_session.json')
const BOT_ACCOUNT_ID  = process.env.BOT_ACCOUNT_ID  || null
const CAMPAIGN_ID     = process.env.CAMPAIGN_ID

// Old Supabase — campaigns, post_queue, bot_accounts, groups
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)

// Denner's Supabase — use service role key so RLS is bypassed for inventory reads
const dennerSupabase = createClient(
  process.env.DENNER_SUPABASE_URL,
  process.env.DENNER_SUPABASE_SERVICE_KEY || process.env.DENNER_SUPABASE_KEY
)

let STOP_REQUESTED = false
let CURRENT_CONTEXT = null
let CURRENT_PAGE = null
let _cdTimer = null

const EMPTY_QUEUE_POLL_MS = 60 * 1000

process.on('SIGTERM', async () => {
  STOP_REQUESTED = true
  console.log('🛑 Stop signal received')
  stopCountdown()
  await safeCleanupRuntime()
  process.exit(0)
})

process.on('SIGINT', async () => {
  STOP_REQUESTED = true
  console.log('🛑 Interrupt signal received')
  stopCountdown()
  await safeCleanupRuntime()
  process.exit(0)
})

// ── Safe DB helpers ───────────────────────────────────────
async function dbUpdate(table, id, data) {
  try {
    const { error } = await supabase.from(table).update(data).eq('id', id)
    if (error) console.log(`   ⚠️ DB(${table}) update: ${error.message}`)
    return !error
  } catch (e) {
    console.log(`   ⚠️ DB update failed: ${e.message}`)
    return false
  }
}

async function dbGet(table, id) {
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).single()
    return error ? null : data
  } catch {
    return null
  }
}


function collectPropertyMedia(prop) {
  const photos = Array.isArray(prop?.photos) ? prop.photos.filter(Boolean).map(url => ({ type: 'image', url })) : []
  const videos = Array.isArray(prop?.videos) ? prop.videos.filter(Boolean).map(url => ({ type: 'video', url })) : []
  return [...photos, ...videos]
}

// Fetch a flat from Denner's system and return it in the shape bot code expects
async function fetchFlatForBot(propertyId) {
  if (!propertyId) return null
  try {
    const [flatRes, mediaRes, intakeRes] = await Promise.all([
      dennerSupabase
        .from('inventory_flats')
        .select('id, title, society_name, monthly_rent, deposit, locality, owner_phone, source_phone, handler_whatsapp_number')
        .eq('id', propertyId)
        .single(),
      dennerSupabase
        .from('inventory_flat_media')
        .select('public_url, media_type, sort_order')
        .eq('flat_id', propertyId)
        .order('sort_order'),
      dennerSupabase
        .from('inventory_flat_intake')
        .select('raw_description')
        .eq('linked_flat_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (flatRes.error || !flatRes.data) return null

    const flat   = flatRes.data
    const media  = mediaRes.data  || []
    const intake = intakeRes.data || null

    // Debug: always log intake result so we can diagnose RLS / view issues
    if (intakeRes.error) {
      console.log(`   ⚠️ intake query error for flat ${propertyId}: ${intakeRes.error.message}`)
    } else if (!intake) {
      console.log(`   ⚠️ intake query returned no row for flat ${propertyId} (view may not exist or no linked record)`)
    } else {
      console.log(`   ✅ intake found for flat ${propertyId}: ${String(intake.raw_description || '').slice(0, 60)}...`)
    }

    const photos = media.filter(m => m.media_type === 'image').map(m => m.public_url)
    const videos = media.filter(m => m.media_type === 'video').map(m => m.public_url)

    // Use society_name as display title (matches useProperties normalization)
    const displayTitle = flat.society_name || flat.title || `Flat #${flat.id}`

    return {
      id:            flat.id,
      title:         displayTitle,
      description:   intake?.raw_description || '',
      rent:          flat.monthly_rent,
      deposit:       flat.deposit,
      locality:      flat.locality,
      phone:         flat.owner_phone || flat.source_phone || '',
      whatsapp_link: flat.handler_whatsapp_number || '',
      photos,
      videos,
    }
  } catch (e) {
    console.log(`   ⚠️ fetchFlatForBot(${propertyId}) failed: ${e.message}`)
    return null
  }
}

async function loadUiProfile(botId) {
  if (!botId) return null
  try {
    const { data, error } = await supabase
      .from('bot_ui_profiles')
      .select('*')
      .eq('bot_account_id', botId)
      .single()
    return error ? null : data
  } catch {
    return null
  }
}

// ── Countdown logger ──────────────────────────────────────
function fmtCountdown(ms) {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = totalSecs % 60
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function startCountdown(ms, label) {
  stopCountdown()
  const end = Date.now() + ms

  const tick = () => {
    if (STOP_REQUESTED) { stopCountdown(); return }
    const rem = end - Date.now()
    if (rem <= 0) { stopCountdown(); return }
    process.stdout.write(`\r⏳ Time left before ${label}: ${fmtCountdown(rem)}   `)
  }

  tick()
  _cdTimer = setInterval(tick, 1000)
}

function stopCountdown() {
  if (_cdTimer !== null) {
    clearInterval(_cdTimer)
    _cdTimer = null
    process.stdout.write('\n')
  }
}

async function interruptibleSleep(ms, countdownLabel = null) {
  if (countdownLabel) startCountdown(ms, countdownLabel)

  const step = 1000
  let elapsed = 0

  try {
    while (elapsed < ms) {
      if (STOP_REQUESTED) throw new Error('BOT_STOPPED')
      const slice = Math.min(step, ms - elapsed)
      await new Promise(r => setTimeout(r, slice))
      elapsed += slice
    }
  } finally {
    if (countdownLabel) stopCountdown()
  }
}

// ── Photo cache — download once, reuse, delete on finish ─
const PHOTO_DIR = join(__dir, 'temp_photos')

async function warmPhotoCache(campaignId) {
  try {
    const { data: queueRows } = await supabase
      .from('post_queue')
      .select('property_id')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')

    if (!queueRows?.length) return

    const uniqueIds = [...new Set(queueRows.map(r => r.property_id).filter(Boolean))]
    if (!uniqueIds.length) return

    const seen = new Set()
    const toDownload = []

    for (const pid of uniqueIds) {
      const p = await fetchFlatForBot(pid)
      if (!p) continue

      console.log(
        `   📋 Property ${String(p.id).slice(0, 8)}: photos=${JSON.stringify(
          p.photos?.slice(0, 1)
        )} (${p.photos?.length || 0} total)`
      )

      const mediaList = collectPropertyMedia(p)
      if (seen.has(p.id) || !mediaList.length) continue
      seen.add(p.id)
      toDownload.push({ ...p, mediaList })
    }

    if (!toDownload.length) {
      console.log('   ℹ️ No photos found for any property in this campaign')
      return
    }

    if (!existsSync(PHOTO_DIR)) mkdirSync(PHOTO_DIR, { recursive: true })
    console.log(`\n📥 Pre-downloading photos for ${toDownload.length} propert(y/ies)...`)

    for (const prop of toDownload) {
      if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

      const mediaList = collectPropertyMedia(prop)
      for (let i = 0; i < Math.min(mediaList.length, 6); i++) {
        const url = mediaList[i]?.url
        if (!url) continue

        const localPath = getMediaPath(prop.id, i, url)
        if (existsSync(localPath)) continue

        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
          console.log(`   ✅ Cached: ${localPath.split('/').pop()} (${mediaList[i].type})`)
        } catch (e) {
          console.log(`   ⚠️ Could not cache media ${i + 1} for ${prop.id}: ${e.message}`)
        }
      }
    }

    console.log('📦 Photo cache ready\n')
  } catch (e) {
    if (e.message === 'BOT_STOPPED') return
    console.log(`⚠️ Photo cache warm failed: ${e.message}`)
  }
}

function getMediaPath(propId, index, url) {
  const urlPath = (url || '').split('?')[0]
  const ext = (urlPath.split('.').pop() || '').toLowerCase()
  const allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v']
  const safeExt = allowed.includes(ext) ? ext : 'bin'
  return join(PHOTO_DIR, `${propId}_${index}.${safeExt}`)
}

function getCachedMedia(propId, prop) {
  const mediaList = collectPropertyMedia(prop)
  const paths = []
  for (let i = 0; i < Math.min(mediaList.length, 6); i++) {
    const p = getMediaPath(propId, i, mediaList[i].url)
    if (existsSync(p)) paths.push(p)
  }
  return paths
}

function cleanPhotoCache() {
  try {
    if (existsSync(PHOTO_DIR)) {
      rmSync(PHOTO_DIR, { recursive: true, force: true })
      console.log('🗑️ Temp photo cache deleted')
    }
  } catch (e) {
    console.log(`⚠️ Could not delete photo cache: ${e.message}`)
  }
}

// ── Queue claiming helpers ────────────────────────────────
async function getNextItem() {
  try {
    const { data: claimedId, error: claimError } = await supabase.rpc('claim_next_post_queue_item', {
      p_campaign_id: CAMPAIGN_ID,
      p_bot_id: BOT_ACCOUNT_ID,
    })

    if (claimError) {
      console.log(`   ⚠️ Claim failed: ${claimError.message}`)
      return null
    }

    if (!claimedId) return null

    const { data, error } = await supabase
      .from('post_queue')
      .select('id, campaign_id, duplicate_warned, status, assigned_bot_id, property_id, groups(id,name,fb_url)')
      .eq('id', claimedId)
      .single()

    if (error) {
      console.log(`   ⚠️ Fetch claimed item failed: ${error.message}`)
      return null
    }

    const flat = await fetchFlatForBot(data.property_id)

    return { ...data, properties: flat }
  } catch (e) {
    console.log(`   ⚠️ getNextItem failed: ${e.message}`)
    return null
  }
}

async function getItemCounts() {
  try {
    const { data, error } = await supabase
      .from('post_queue')
      .select('status')
      .eq('campaign_id', CAMPAIGN_ID)
      .in('status', ['pending', 'processing', 'failed'])

    if (error) {
      console.log(`   ⚠️ Item count check failed: ${error.message}`)
      return { pending: 1, processing: 0, failed: 0 } // assume work remains on error
    }

    const rows = data || []
    return {
      pending:    rows.filter(r => r.status === 'pending').length,
      processing: rows.filter(r => r.status === 'processing').length,
      failed:     rows.filter(r => r.status === 'failed').length,
    }
  } catch {
    return { pending: 1, processing: 0, failed: 0 }
  }
}

async function markItem(id, status, errorLog = null, postUrl = null) {
  const payload = {
    status,
    error_log: errorLog,
    posted_at: status === 'posted' ? new Date().toISOString() : null,
    post_url: status === 'posted' ? postUrl : null,
    claimed_at: null,
    ...(BOT_ACCOUNT_ID ? { assigned_bot_id: BOT_ACCOUNT_ID } : {}),
  }

  const ok = await dbUpdate('post_queue', id, payload)
  if (!ok) {
    const { post_url, ...withoutPostUrl } = payload
    await dbUpdate('post_queue', id, withoutPostUrl)
  }
}

// ── Selector helpers ──────────────────────────────────────
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildProfileLocators(page, profile) {
  if (!profile) return []

  const locators = []
  const push = (locator) => {
    if (locator) locators.push(locator)
  }

  for (const selector of profile.selectorCandidates || []) {
    try {
      push(page.locator(selector).first())
    } catch {}
  }

  const tag = profile.tagName || ''
  const role = profile.role
  const ariaLabel = profile.ariaLabel
  const text = profile.text
  const contenteditable = profile.contenteditable
  const type = profile.type

  try {
    if (ariaLabel && role) push(page.locator(`[aria-label="${ariaLabel}"][role="${role}"]`).first())
  } catch {}
  try {
    if (ariaLabel) push(page.locator(`[aria-label="${ariaLabel}"]`).first())
  } catch {}
  try {
    if (tag && role) push(page.locator(`${tag}[role="${role}"]`).first())
  } catch {}
  try {
    if (tag && contenteditable === 'true') push(page.locator(`${tag}[contenteditable="true"]`).first())
  } catch {}
  try {
    if (contenteditable === 'true') push(page.locator('[contenteditable="true"]').first())
  } catch {}
  try {
    if (tag && type) push(page.locator(`${tag}[type="${type}"]`).first())
  } catch {}
  try {
    if (tag && role && text) {
      push(page.locator(`${tag}[role="${role}"]`).filter({ hasText: new RegExp(escapeRegex(text), 'i') }).first())
    }
  } catch {}
  try {
    if (role && text) {
      push(page.locator(`[role="${role}"]`).filter({ hasText: new RegExp(escapeRegex(text), 'i') }).first())
    }
  } catch {}

  return locators
}

async function tryClickProfile(page, profile, label, options = {}) {
  const { waitMs = 2000, allowDisabled = false } = options

  for (const locator of buildProfileLocators(page, profile)) {
    try {
      if (!(await locator.isVisible({ timeout: waitMs }))) continue
      if (!allowDisabled) {
        const disabled = await locator.getAttribute('aria-disabled')
        if (disabled === 'true') continue
      }
      await locator.click()
      console.log(`   🎯 Used trained selector for ${label}`)
      return true
    } catch {}
  }

  return false
}

async function findProfileLocator(page, profile, waitMs = 2000) {
  for (const locator of buildProfileLocators(page, profile)) {
    try {
      if (await locator.isVisible({ timeout: waitMs })) return locator
    } catch {}
  }
  return null
}

// ── Runtime lifecycle helpers ─────────────────────────────
function isClosedTargetError(err) {
  const msg = String(err?.message || err || '')
  return (
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('context or browser has been closed') ||
    msg.includes('page.goto: Target page, context or browser has been closed')
  )
}

async function safeCleanupRuntime() {
  stopCountdown()

  try { await CURRENT_PAGE?.close?.() } catch {}
  try { await CURRENT_CONTEXT?.close?.() } catch {}

  CURRENT_PAGE = null
  CURRENT_CONTEXT = null
}

async function createFreshRuntime() {
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  const userDataDir = SESSION_FILE.replace('.json', '_profile')
  if (!existsSync(userDataDir)) {
    throw new Error(`No browser profile: ${userDataDir}`)
  }

  await safeCleanupRuntime()

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  })

  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }
  })

  CURRENT_CONTEXT = context
  CURRENT_PAGE = page

  return { context, page }
}

async function ensureLivePage() {
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  if (!CURRENT_CONTEXT || !CURRENT_PAGE || CURRENT_PAGE.isClosed()) {
    console.log('   ♻️ Rebuilding browser session...')
    await createFreshRuntime()
  }

  return CURRENT_PAGE
}

async function recoverRuntimeAfterBrowserDeath() {
  console.log('   ♻️ Browser/page was closed. Rebuilding session...')
  await createFreshRuntime()

  const page = CURRENT_PAGE
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.bringToFront()
  await interruptibleSleep(2000)

  if (page.url().includes('login')) {
    throw new Error('Session is no longer logged in')
  }

  console.log('   ✅ Browser session rebuilt')
  return page
}

function computeEffectiveRuntime(botCfg, campaignCfg) {
  const botMax = Number(botCfg.max_posts_per_day ?? 18)
  const botStart = Number(botCfg.post_start_hour ?? 9)
  const botEnd = Number(botCfg.post_end_hour ?? 20)

  const campaignMax = Number(campaignCfg?.posts_per_day_limit ?? botMax)
  const campaignStart = Number(campaignCfg?.posting_start_hour ?? botStart)
  const campaignEnd = Number(campaignCfg?.posting_end_hour ?? botEnd)

  const effectiveMaxPostsPerDay = Math.min(botMax, campaignMax)
  const effectiveStartHour = Math.max(botStart, campaignStart)
  const effectiveEndHour = Math.min(botEnd, campaignEnd)

  return {
    effectiveMaxPostsPerDay,
    effectiveStartHour,
    effectiveEndHour,
    botMax,
    botStart,
    botEnd,
    campaignMax,
    campaignStart,
    campaignEnd,
    hasValidWindow: effectiveStartHour < effectiveEndHour,
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  if (!CAMPAIGN_ID) {
    console.error('❌ CAMPAIGN_ID not set')
    process.exit(1)
  }

  let cfg = {
    name: 'Bot',
    min_delay_seconds: 480,
    max_delay_seconds: 900,
    max_posts_per_day: 18,
    post_start_hour: 9,
    post_end_hour: 20,
    session_cap: 8,
    session_break_min: 120,
    session_break_max: 180,
  }

  let campaignCfg = {
    posts_per_day_limit: 18,
    posting_start_hour: 9,
    posting_end_hour: 20,
  }

  let uiProfile = null

  if (BOT_ACCOUNT_ID) {
    const row = await dbGet('bot_accounts', BOT_ACCOUNT_ID)
    if (row) cfg = { ...cfg, ...row }
    uiProfile = await loadUiProfile(BOT_ACCOUNT_ID)
    await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, {
      status: 'running',
      last_active: new Date().toISOString(),
    })
  }

  const campaignRow = await dbGet('campaigns', CAMPAIGN_ID)
  if (campaignRow) {
    campaignCfg = { ...campaignCfg, ...campaignRow }
  }

  let runtime = computeEffectiveRuntime(cfg, campaignCfg)

  if (!runtime.hasValidWindow) {
    console.error('❌ No overlapping posting window between bot and campaign')
    console.error(`   Bot window: ${runtime.botStart}:00 – ${runtime.botEnd}:00`)
    console.error(`   Campaign window: ${runtime.campaignStart}:00 – ${runtime.campaignEnd}:00`)
    if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
    process.exit(1)
  }

  const getDelay = () =>
    cfg.min_delay_seconds * 1000 +
    Math.random() * ((cfg.max_delay_seconds - cfg.min_delay_seconds) * 1000)

  console.log(`\n🏠 FB Listing Bot — ${cfg.name}`)
  console.log(`   Campaign:            ${CAMPAIGN_ID}`)
  console.log(`   Effective Max/day:   ${runtime.effectiveMaxPostsPerDay}`)
  console.log(`   Effective Window:    ${runtime.effectiveStartHour}:00 – ${runtime.effectiveEndHour}:00`)
  console.log(`   Bot Max/day:         ${runtime.botMax}`)
  console.log(`   Bot Window:          ${runtime.botStart}:00 – ${runtime.botEnd}:00`)
  console.log(`   Campaign Max/day:    ${runtime.campaignMax}`)
  console.log(`   Campaign Window:     ${runtime.campaignStart}:00 – ${runtime.campaignEnd}:00`)
  console.log(`   Delay:               ${cfg.min_delay_seconds}s – ${cfg.max_delay_seconds}s`)
  console.log(`   Runtime now:         ${new Date().toString()}`)
  console.log(`   Runtime hour:        ${new Date().getHours()}`)
  console.log(`   TZ env:              ${process.env.TZ || 'not set'}`)
  console.log(`   UI profile:          ${uiProfile ? 'trained selectors loaded' : 'using fallback selectors'}\n`)

  const userDataDir = SESSION_FILE.replace('.json', '_profile')
  if (!existsSync(userDataDir)) {
    console.error(`❌ No browser profile: ${userDataDir}`)
    if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
    process.exit(1)
  }

  await warmPhotoCache(CAMPAIGN_ID)
  await createFreshRuntime()

  let page = CURRENT_PAGE

  console.log('🔍 Verifying session...')
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.bringToFront()
  await interruptibleSleep(3000)

  if (page.url().includes('login')) {
    console.error('❌ Not logged in — use "Login to Facebook" in the dashboard.')
    await safeCleanupRuntime()
    cleanPhotoCache()
    if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
    process.exit(1)
  }
  console.log('✅ Logged in\n')

  let todayCount = 0
  let todayDate = new Date().toDateString()
  let sessionCount = 0
  let isFirstPost = true
  let loopCount = 0
  let browserDeathCount = 0

  while (true) {
    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    loopCount++

    if (BOT_ACCOUNT_ID && loopCount % 5 === 0) {
      const freshBot = await dbGet('bot_accounts', BOT_ACCOUNT_ID)
      if (freshBot) cfg = { ...cfg, ...freshBot }

      const freshCampaign = await dbGet('campaigns', CAMPAIGN_ID)
      if (freshCampaign) campaignCfg = { ...campaignCfg, ...freshCampaign }

      runtime = computeEffectiveRuntime(cfg, campaignCfg)

      if (!runtime.hasValidWindow) {
        console.log('❌ Bot and campaign windows no longer overlap')
        if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
        break
      }
    }

    const now = new Date()
    if (now.toDateString() !== todayDate) {
      todayDate = now.toDateString()
      todayCount = 0
      console.log('🌅 New day — counter reset')
    }

    const hour = now.getHours()
    if (hour < runtime.effectiveStartHour || hour >= runtime.effectiveEndHour) {
      const next = new Date()
      if (hour >= runtime.effectiveEndHour) next.setDate(next.getDate() + 1)
      next.setHours(runtime.effectiveStartHour, 0, 0, 0)
      const waitMs = next - Date.now()
      console.log(`⏰ Outside effective window (${runtime.effectiveStartHour}:00–${runtime.effectiveEndHour}:00)`)
      console.log(`   Current runtime clock: ${now.toString()}`)
      await interruptibleSleep(waitMs, 'Waiting for posting window')
      continue
    }

    if (todayCount >= runtime.effectiveMaxPostsPerDay) {
      const next = new Date()
      next.setDate(next.getDate() + 1)
      next.setHours(runtime.effectiveStartHour, 0, 0, 0)
      console.log(`📊 Effective daily cap reached (${runtime.effectiveMaxPostsPerDay}/day)`)
      await interruptibleSleep(next - Date.now(), 'Waiting for next day')
      continue
    }

    if (sessionCount >= cfg.session_cap) {
      const breakMs =
        (cfg.session_break_min +
          Math.random() * (cfg.session_break_max - cfg.session_break_min)) *
        60000
      console.log(`☕ Session break (${cfg.session_cap} posts done)`)
      await interruptibleSleep(breakMs, 'Session break')
      sessionCount = 0
      continue
    }

    const item = await getNextItem()
    if (!item) {
      const counts = await getItemCounts()

      if (counts.pending === 0 && counts.processing === 0) {
        if (counts.failed > 0) {
          console.log(`\n⚠️  No pending posts remain — ${counts.failed} post(s) ended in failed status.`)
          console.log('   Use "Retry Failed" in the dashboard to requeue them.')
          console.log('   Campaign left active so you can retry without losing progress.')
        } else {
          console.log('\n🎉 All posts complete!')
          await dbUpdate('campaigns', CAMPAIGN_ID, { status: 'completed' })
          console.log('✅ Campaign marked as completed')
        }
        break
      }

      console.log('ℹ️ No due items right now — waiting')
      await interruptibleSleep(EMPTY_QUEUE_POLL_MS, 'next available post')
      continue
    }

    console.log(`\n📤 [${todayCount + 1}/${runtime.effectiveMaxPostsPerDay}] → ${item.groups.name}`)
    console.log(`   Listing: ${item.properties.title}`)

    page = await ensureLivePage()

    const success = await postToGroup(page, item, uiProfile)

    if (success === 'REBUILD_AND_RETRY') {
      browserDeathCount++

      if (browserDeathCount >= 3) {
        console.log('   ❌ Browser session lost repeatedly. Bot stopped for safety.')
        await markItem(item.id, 'failed', 'Browser session lost repeatedly')
        if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
        break
      }

      try {
        page = await recoverRuntimeAfterBrowserDeath()
        const retrySuccess = await postToGroup(page, item, uiProfile, true)

        if (isPostSuccess(retrySuccess)) {
          browserDeathCount = 0
          await markItem(item.id, 'posted', null, retrySuccess.postUrl)
          todayCount++
          sessionCount++

          if (BOT_ACCOUNT_ID) {
            const botRow = await dbGet('bot_accounts', BOT_ACCOUNT_ID)
            await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, {
              posts_today: todayCount,
              total_posts: (botRow?.total_posts || 0) + 1,
              last_active: new Date().toISOString(),
              posts_today_date: now.toISOString().split('T')[0],
            })
          }

          console.log(`   ✅ Posted after recovery! (${todayCount}/${runtime.effectiveMaxPostsPerDay} today)`)
        } else {
          const reason = _postError
            ? `After browser recovery: ${_postError}`
            : 'Could not complete post after browser recovery'
          await markItem(item.id, 'failed', reason)
          console.log(`   ❌ Failed after recovery — moving to next`)
        }
      } catch (e) {
        await markItem(item.id, 'failed', `Browser recovery failed: ${e.message}`)
        console.log(`   ❌ Browser recovery failed: ${e.message}`)
      }
    } else if (isPostSuccess(success)) {
      browserDeathCount = 0
      await markItem(item.id, 'posted', null, success.postUrl)
      todayCount++
      sessionCount++

      if (BOT_ACCOUNT_ID) {
        const botRow = await dbGet('bot_accounts', BOT_ACCOUNT_ID)
        await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, {
          posts_today: todayCount,
          total_posts: (botRow?.total_posts || 0) + 1,
          last_active: new Date().toISOString(),
          posts_today_date: now.toISOString().split('T')[0],
        })
      }

      console.log(`   ✅ Posted! (${todayCount}/${runtime.effectiveMaxPostsPerDay} today)`)
    } else {
      const reason = _postError || 'Bot could not complete post'
      await markItem(item.id, 'failed', reason)
      console.log(`   ❌ Failed — ${reason}`)
    }

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    if (isFirstPost) {
      isFirstPost = false
      const minM = Math.round(cfg.min_delay_seconds / 60)
      const maxM = Math.round(cfg.max_delay_seconds / 60)
      console.log(`   ⚡ First post done — next post in ${minM}–${maxM} min`)
    } else {
      const delayMs = getDelay()
      await interruptibleSleep(delayMs, 'Waiting before next post')
    }
  }

  await safeCleanupRuntime()
  cleanPhotoCache()
  if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'idle' })
  console.log('\n✅ Bot finished.')
}

// Holds the failure reason from the most recent postToGroup call
let _postError = null

function logPostError(step, detail = '') {
  const msg = detail ? `${step} — ${detail}` : step
  console.log(`   ❌ ${msg}`)
  _postError = msg
}

// ── Post to one group ─────────────────────────────────────
async function postToGroup(page, item, uiProfile, isRetry = false) {
  _postError = null

  const text   = buildText(item)
  const propId = item.properties?.id
  const media  = collectPropertyMedia(item.properties || {})
  const propLabel  = `"${item.properties?.title || propId}" → ${item.groups?.name}`

  // Guard: skip post if there is no text to type
  if (!text || text.trim().length < 5) {
    logPostError('No post body — raw_description is empty or missing', propLabel)
    return false
  }

  try {
    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    page = await ensureLivePage()

    console.log(`   🌐 Opening group${isRetry ? ' (retry)' : ''}...`)
    await page.goto(item.groups.fb_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.bringToFront()
    await interruptibleSleep(randomBetween(3000, 5000))

    try {
      await page.keyboard.press('Escape')
      await interruptibleSleep(500)
    } catch {}

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    console.log('   🖊️ Opening composer...')
    if (!(await openComposer(page, uiProfile))) {
      await page.screenshot({ path: join(__dir, `debug_composer_${Date.now()}.png`) })
      logPostError('Composer did not open', propLabel)
      return false
    }

    await interruptibleSleep(randomBetween(1500, 2500))

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    console.log('   ✍️ Typing text...')
    if (!(await typeText(page, text, uiProfile))) {
      logPostError('Could not type text into composer', propLabel)
      return false
    }

    await interruptibleSleep(randomBetween(800, 1200))

    if (media.length > 0 && propId) {
      const cachedPaths = getCachedMedia(propId, item.properties || {})
      console.log(`   🖼️ Cached media for ${String(propId).slice(0, 12)}: ${cachedPaths.length} file(s)`)

      if (cachedPaths.length > 0) {
        await attachMedia(page, cachedPaths, uiProfile)
        await interruptibleSleep(randomBetween(2000, 3000))
      } else {
        console.log('   ⚠️ No cached media — posting text only')
        console.log(`   📁 Expected in: ${PHOTO_DIR}`)
      }
    }

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    const beforePostUrls = await collectPostUrls(page)

    console.log('   🖱️ Clicking Post...')
    if (!(await clickPost(page, uiProfile))) {
      await page.screenshot({ path: join(__dir, `debug_post_${Date.now()}.png`) })
      logPostError('Post button did not respond', propLabel)
      return false
    }

    await interruptibleSleep(randomBetween(3000, 5000))
    const postUrl = await findNewPostUrl(page, beforePostUrls, item.groups?.fb_url)
    if (postUrl) {
      console.log(`   🔗 Post URL captured: ${postUrl}`)
    } else {
      console.log('   ⚠️ Posted, but post URL could not be detected automatically')
    }

    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await interruptibleSleep(1500)

    return { ok: true, postUrl }
  } catch (err) {
    if (err.message === 'BOT_STOPPED') throw err
    const firstLine = String(err.message || err).split('\n')[0]
    if (isClosedTargetError(err)) {
      console.log(`   ⚠️ Browser closed mid-post [${propLabel}]: ${firstLine}`)
      _postError = `Browser closed: ${firstLine}`
      return 'REBUILD_AND_RETRY'
    }
    console.log(`   ❌ Unexpected error [${propLabel}]: ${firstLine}`)
    if (err.stack) console.log(`      ${err.stack.split('\n').slice(1, 3).join('\n      ')}`)
    _postError = firstLine
    return false
  }
}

function isPostSuccess(result) {
  return result === true || result?.ok === true
}

async function openComposer(page, uiProfile) {
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  if (uiProfile?.composer_selector) {
    if (await tryClickProfile(page, uiProfile.composer_selector, 'composer', { waitMs: 2500, allowDisabled: true })) {
      return true
    }
  }

  try {
    const el = page.locator('[aria-label="Create a post"]').first()
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click()
      return true
    }
  } catch {}

  try {
    const ok = await page.evaluate(() => {
      for (const btn of document.querySelectorAll('[role="button"]')) {
        const t = btn.textContent?.trim() || ''
        const l = btn.getAttribute('aria-label') || ''
        if (t === 'Write something...' || l === 'Create a post') {
          btn.click()
          return true
        }
      }
      return false
    })
    if (ok) return true
  } catch {}

  try {
    const el = page
      .locator('div[role="button"]')
      .filter({ hasText: /write something|what.s on your mind/i })
      .first()
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click()
      return true
    }
  } catch {}

  return false
}

async function attachMedia(page, localPaths, uiProfile) {
  if (!localPaths?.length) return
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  console.log(`   📎 Attaching media: ${localPaths.map((p) => p.split('/').pop()).join(', ')}`)

  let photoButtonEl = null

  if (uiProfile?.photo_selector) {
    photoButtonEl = await findProfileLocator(page, uiProfile.photo_selector, 2500)
    if (photoButtonEl) console.log('   🎯 Using trained selector for photo button')
  }

  if (!photoButtonEl) {
    const photoSelectors = [
      '[aria-label="Photo/video"]',
      '[aria-label="Photo/Video"]',
      '[aria-label="Add photos or videos"]',
    ]

    for (const sel of photoSelectors) {
      try {
        const el = page.locator(sel).first()
        if (await el.isVisible({ timeout: 2000 })) {
          photoButtonEl = el
          console.log(`   📷 Found photo button: ${sel}`)
          break
        }
      } catch {}
    }
  }

  if (!photoButtonEl) {
    const found = await page
      .evaluate(() => {
        const btns = document.querySelectorAll('[role="button"]')
        for (const btn of btns) {
          const l = (btn.getAttribute('aria-label') || '').toLowerCase()
          const t = (btn.textContent || '').trim().toLowerCase()
          if (l.includes('photo') || t === 'photo/video') {
            btn.setAttribute('data-playwright-photo', 'true')
            return true
          }
        }
        return false
      })
      .catch(() => false)

    if (found) {
      photoButtonEl = page.locator('[data-playwright-photo="true"]').first()
      console.log('   📷 Found photo button via evaluate')
    }
  }

  if (!photoButtonEl) {
    console.log('   ⚠️ Media button not found in composer — skipping media')
    return
  }

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      photoButtonEl.click(),
    ])
    await fileChooser.setFiles(localPaths)
    await interruptibleSleep(randomBetween(3000, 5000))
    console.log(`   ✅ ${localPaths.length} media file(s) attached via file chooser`)
    return
  } catch (e) {
    console.log(`   ⚠️ File chooser strategy failed: ${String(e.message).split('\n')[0]}`)
  }

  try {
    await photoButtonEl.click()
    await interruptibleSleep(1500)
    const inp = page.locator('input[type="file"]').first()
    if ((await inp.count()) > 0) {
      await inp.setInputFiles(localPaths, { timeout: 5000 })
      await interruptibleSleep(randomBetween(3000, 5000))
      console.log(`   ✅ ${localPaths.length} media file(s) attached via hidden input`)
      return
    }
  } catch (e) {
    console.log(`   ⚠️ Hidden input strategy failed: ${String(e.message).split('\n')[0]}`)
  }

  console.log('   ⚠️ Could not attach media — posting text only')
}

async function typeText(page, text, uiProfile) {
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  if (uiProfile?.textbox_selector) {
    const locator = await findProfileLocator(page, uiProfile.textbox_selector, 2500)
    if (locator) {
      try {
        if (((await locator.getAttribute('aria-label')) || '').toLowerCase().includes('comment')) {
          throw new Error('Matched comment box')
        }
        await locator.click()
        await interruptibleSleep(400)
        await insertPlainText(locator, text)
        if (((await locator.textContent()) || '').length > 5) {
          console.log('   🎯 Used trained selector for textbox')
          return true
        }
      } catch {}
    }
  }

  for (const sel of ['[role="dialog"] [role="textbox"]', '[role="dialog"] [contenteditable="true"]']) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 6000 })
      if (((await el.getAttribute('aria-label')) || '').toLowerCase().includes('comment')) continue
      await el.click()
      await interruptibleSleep(400)
      await insertPlainText(el, text)
      if (((await el.textContent()) || '').length > 5) return true
    } catch {}
  }

  try {
    return await page.evaluate((t) => {
      for (const box of document.querySelectorAll('[contenteditable="true"]')) {
        if (((box.getAttribute('aria-label')) || '').toLowerCase().includes('comment')) continue
        const r = box.getBoundingClientRect()
        if (r.width > 200 && r.height > 30) {
          box.focus()
          document.execCommand('insertText', false, t)
          return box.textContent.length > 0
        }
      }
      return false
    }, text)
  } catch {
    return false
  }
}

async function insertPlainText(locator, text) {
  await locator.evaluate((el, value) => {
    el.focus()

    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    const inserted = document.execCommand('insertText', false, value)
    if (!inserted && el.isContentEditable) {
      el.textContent = value
    } else if (!inserted && 'value' in el) {
      el.value = value
    }

    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: value,
    }))
  }, text)
}

async function clickPost(page, uiProfile) {
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  if (uiProfile?.post_selector) {
    if (await tryClickProfile(page, uiProfile.post_selector, 'post button', { waitMs: 2500, allowDisabled: false })) {
      return true
    }
  }

  for (const sel of ['[aria-label="Post"][role="button"]', '[data-testid="react-composer-post-button"]']) {
    try {
      const el = page.locator(sel).last()
      if (
        (await el.isVisible({ timeout: 2000 })) &&
        (await el.getAttribute('aria-disabled')) !== 'true'
      ) {
        await el.click()
        return true
      }
    } catch {}
  }

  return await page.evaluate(() => {
    for (const btn of [...document.querySelectorAll('[role="button"]')].reverse()) {
      const l = btn.getAttribute('aria-label') || ''
      const t = btn.textContent?.trim() || ''
      if ((l === 'Post' || t === 'Post') && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click()
        return true
      }
    }
    return false
  })
}

async function collectPostUrls(page) {
  try {
    const urls = await page.evaluate(() => {
      const values = []

      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || ''
        if (!href) continue

        const clean = href.split('?')[0]
        const looksLikePost =
          /\/groups\/[^/]+\/posts\/\d+/i.test(clean) ||
          /\/groups\/permalink\/\d+/i.test(clean) ||
          /\/permalink\.php/i.test(clean) ||
          /\/posts\/\d+/i.test(clean) ||
          /story_fbid=\d+/i.test(href)

        if (looksLikePost) values.push(href)
      }

      return values
    })

    return [...new Set((urls || []).map(normalizeFacebookPostUrl).filter(Boolean))]
  } catch {
    return []
  }
}

async function findNewPostUrl(page, beforeUrls = [], groupUrl = '') {
  const before = new Set((beforeUrls || []).map(normalizeFacebookPostUrl).filter(Boolean))

  for (let i = 0; i < 8; i++) {
    const currentUrls = await collectPostUrls(page)
    const added = currentUrls.find(url => !before.has(url))
    if (added) return added
    await interruptibleSleep(1000)
  }

  const fallback = await findLatestVisiblePostUrl(page)
  if (fallback && !before.has(fallback)) return fallback

  const groupId = extractFacebookGroupId(groupUrl)
  if (!groupId) return null

  const anyGroupPost = (await collectPostUrls(page)).find(url => url.includes(`/groups/${groupId}/posts/`))
  return anyGroupPost || null
}

async function findLatestVisiblePostUrl(page) {
  try {
    const href = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href]')]
      const timestampAnchors = anchors.filter((a) => {
        const aria = (a.getAttribute('aria-label') || '').toLowerCase()
        const text = (a.textContent || '').trim().toLowerCase()
        const href = a.href || ''
        const hasTimeText = /\b(now|just now|m|h|min|hr|yesterday)\b/.test(text)
        const hasTimeAria = /\b(now|just now|minute|hour|yesterday)\b/.test(aria)
        const looksLikePost = /\/groups\/[^/]+\/posts\/\d+|\/posts\/\d+|story_fbid=\d+|permalink/i.test(href)
        return looksLikePost && (hasTimeText || hasTimeAria)
      })

      return timestampAnchors[0]?.href || null
    })

    return normalizeFacebookPostUrl(href)
  } catch {
    return null
  }
}

function normalizeFacebookPostUrl(value) {
  if (!value) return null

  try {
    const url = new URL(value, 'https://www.facebook.com')
    url.hash = ''

    const storyId = url.searchParams.get('story_fbid')
    const groupId = url.searchParams.get('group_id') || extractFacebookGroupId(url.pathname)
    if (storyId && groupId) return `https://www.facebook.com/groups/${groupId}/posts/${storyId}/`

    for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key)

    if (url.hostname.endsWith('facebook.com')) {
      url.hostname = 'www.facebook.com'
      return url.toString()
    }
  } catch {}

  return null
}

function extractFacebookGroupId(value = '') {
  const match = String(value).match(/\/groups\/([^/?#]+)/i)
  return match?.[1] || null
}

function buildText(item) {
  const p = item.properties
  // description maps to raw_description from inventory_flat_intake — no title fallback
  let t = p.description || ''
  t = t.replace(/\{phone\}/g, p.phone || '')
  t = t.replace(/\{whatsapp_link\}/g, p.whatsapp_link || '')
  t = t.replace(/\{locality\}/g, p.locality || '')
  t = t.replace(/\{rent\}/g, p.rent ? '₹' + Number(p.rent).toLocaleString('en-IN') : '')
  t = t.replace(/\{deposit\}/g, p.deposit ? '₹' + Number(p.deposit).toLocaleString('en-IN') : '')
  // Strip links (they send posts to admin approval); stored description is untouched
  return cleanPostText(t)
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min))
}

main().catch(async (err) => {
  if (err.message === 'BOT_STOPPED') {
    console.log('🛑 Bot stopped cleanly')
    cleanPhotoCache()
    if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'idle' })
    process.exit(0)
  }

  console.error('❌ Bot crashed:', err.message)
  await safeCleanupRuntime()
  cleanPhotoCache()
  if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
  process.exit(1)
})
