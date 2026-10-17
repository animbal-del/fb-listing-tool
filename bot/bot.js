// bot.js — FB Group Posting Bot
// Bot timing = execution behavior
// Campaign timing = campaign-level constraint
// Effective runtime uses Option C:
//   daily cap   = min(bot max/day, campaign posts/day)
//   start hour  = max(bot start, campaign start)
//   end hour    = min(bot end, campaign end)

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'
import { cleanPostText } from './postText.js'
import { fillComposer, clearComposer, readComposerText, composerTextMatches } from './composer.js'

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
let COMPOSER_LOCATOR = null
let BOT_NAME = 'This bot'
let _cdTimer = null

const EMPTY_QUEUE_POLL_MS = 60 * 1000

// Facebook page loads: slow server moments get a longer wait and one retry
const PAGE_LOAD_TIMEOUT_MS = 60 * 1000

// The VPS has 1 CPU — only this many bots load/post on Facebook at the same moment.
// Other bots keep running and wait their turn (a post takes ~1–2 min, delays are 8–15 min).
const MAX_ACTIVE_BOTS = Number(process.env.MAX_ACTIVE_BOTS || 2)
const SLOT_DIR = '/tmp/fb_bot_slots'
const SLOT_STALE_MS = 20 * 60 * 1000

// Joining many groups quickly gets accounts checkpointed — cap joins per bot per day
const MAX_JOINS_PER_DAY = Number(process.env.MAX_JOINS_PER_DAY || 6)
// Exit code that tells server.js the account must log in again (don't chain campaigns)
const EXIT_NEEDS_LOGIN = 3
const HOUR_MS = 60 * 60 * 1000

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
        .select('id, flat_code, title, society_name, monthly_rent, deposit, locality, owner_phone, source_phone, handler_whatsapp_number')
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
      code:          flat.flat_code || '',
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
          const buf = Buffer.from(await res.arrayBuffer())
          if (isWebp(buf)) {
            // Facebook rejects WebP on some accounts ("format we don't support") — upload a JPG instead
            await webpToJpg(buf, localPath)
            console.log(`   ✅ Cached: ${localPath.split('/').pop()} (converted from WebP)`)
          } else {
            writeFileSync(localPath, buf)
            console.log(`   ✅ Cached: ${localPath.split('/').pop()} (${mediaList[i].type})`)
          }
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
  const allowed = ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'webm', 'm4v']
  // WebP photos are converted to JPG when cached
  const safeExt = ext === 'webp' ? 'jpg' : allowed.includes(ext) ? ext : 'bin'
  return join(PHOTO_DIR, `${propId}_${index}.${safeExt}`)
}

const execFileAsync = promisify(execFile)

function isWebp(buf) {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
}

// Convert with ImageMagick; [0] keeps only the first frame of an animated WebP
async function webpToJpg(buf, outPath) {
  const tmp = `${outPath}.src.webp`
  writeFileSync(tmp, buf)
  try {
    await execFileAsync('convert', [`${tmp}[0]`, '-auto-orient', '-background', 'white', '-flatten', '-quality', '90', `jpg:${outPath}`])
  } finally {
    rmSync(tmp, { force: true })
  }
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
      .select('id, campaign_id, duplicate_warned, status, assigned_bot_id, property_id, message_text, groups(id,name,fb_url)')
      .eq('id', claimedId)
      .single()

    if (error) {
      console.log(`   ⚠️ Fetch claimed item failed: ${error.message}`)
      return null
    }

    // Message campaigns: post the text saved at launch exactly as written
    if (data.message_text) return { ...data, properties: null, message: { text: data.message_text } }

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

// Put a claimed post back so any bot that can post in the group picks it up
async function requeueItem(id, note) {
  await dbUpdate('post_queue', id, {
    status: 'pending',
    error_log: note,
    assigned_bot_id: null,
    claimed_at: null,
  })
}

// ── Group access (which bot can post in which group) ──────
async function setGroupAccess(groupId, status, { retryMs = null, note = null, joined = false } = {}) {
  if (!BOT_ACCOUNT_ID || !groupId) return
  const now = new Date()
  const row = {
    bot_account_id: BOT_ACCOUNT_ID,
    group_id: groupId,
    status,
    retry_after: retryMs ? new Date(now.getTime() + retryMs).toISOString() : null,
    note,
    updated_at: now.toISOString(),
    ...(joined ? { joined_at: now.toISOString() } : {}),
  }
  try {
    const { error } = await supabase.from('bot_group_access').upsert(row, { onConflict: 'bot_account_id,group_id' })
    if (error) console.log(`   ⚠️ DB(bot_group_access) upsert: ${error.message}`)
  } catch (e) {
    console.log(`   ⚠️ DB(bot_group_access) upsert failed: ${e.message}`)
  }
}

async function joinsToday() {
  if (!BOT_ACCOUNT_ID) return 0
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  try {
    const { count, error } = await supabase
      .from('bot_group_access')
      .select('group_id', { count: 'exact', head: true })
      .eq('bot_account_id', BOT_ACCOUNT_ID)
      .gte('joined_at', dayStart.toISOString())
    return error ? MAX_JOINS_PER_DAY : count || 0 // unknown → assume cap reached
  } catch {
    return MAX_JOINS_PER_DAY
  }
}

function msUntilTomorrow() {
  const next = new Date()
  next.setDate(next.getDate() + 1)
  next.setHours(0, 5, 0, 0)
  return next - Date.now()
}

// Turn a group off for everyone and skip its waiting posts in every campaign
async function disableGroup(groupId, reason, note) {
  await dbUpdate('groups', groupId, {
    active: false,
    disabled_reason: reason,
    disabled_at: new Date().toISOString(),
  })
  try {
    await supabase
      .from('post_queue')
      .update({ status: 'skipped', error_log: note })
      .eq('group_id', groupId)
      .eq('status', 'pending')
  } catch {}
}

// True when every pending post in this campaign is in a group this bot must skip for now
async function allPendingBlockedForMe() {
  if (!BOT_ACCOUNT_ID) return false
  try {
    const [pendingRes, blockedRes] = await Promise.all([
      supabase.from('post_queue').select('group_id').eq('campaign_id', CAMPAIGN_ID).eq('status', 'pending'),
      supabase
        .from('bot_group_access')
        .select('group_id')
        .eq('bot_account_id', BOT_ACCOUNT_ID)
        .gt('retry_after', new Date().toISOString()),
    ])
    if (pendingRes.error || blockedRes.error) return false
    const blocked = new Set((blockedRes.data || []).map(r => r.group_id))
    const pending = pendingRes.data || []
    return pending.length > 0 && pending.every(r => blocked.has(r.group_id))
  } catch {
    return false
  }
}

async function markItem(id, status, errorLog = null) {
  await dbUpdate('post_queue', id, {
    status,
    error_log: errorLog,
    posted_at: status === 'posted' ? new Date().toISOString() : null,
    claimed_at: null,
    ...(BOT_ACCOUNT_ID ? { assigned_bot_id: BOT_ACCOUNT_ID } : {}),
  })
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

// Open a Facebook URL; on a timeout wait a bit and try once more
async function openPage(page, url, { retry = true } = {}) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS })
  } catch (e) {
    if (!retry || e.name !== 'TimeoutError' || STOP_REQUESTED) throw e
    console.log('   ⚠️ Facebook was slow to load — retrying once...')
    await interruptibleSleep(5000)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS })
  }
}

// ── Browser slots — shared across bot processes via lock dirs ─
function slotIsStale(dir) {
  try {
    if (Date.now() - statSync(dir).mtimeMs > SLOT_STALE_MS) return true
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)
    return false
  } catch (e) {
    return e.code === 'ESRCH'
  }
}

function tryTakeSlot() {
  mkdirSync(SLOT_DIR, { recursive: true })
  for (let i = 0; i < MAX_ACTIVE_BOTS; i++) {
    const dir = join(SLOT_DIR, `slot_${i}`)
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'pid'), String(process.pid))
      return dir
    } catch {
      if (slotIsStale(dir)) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      }
    }
  }
  return null
}

// onStopWhileWaiting runs if the bot is stopped before it got a turn
async function withBrowserSlot(fn, onStopWhileWaiting = null) {
  let dir = tryTakeSlot()
  if (!dir) {
    console.log(`   ⏸️ ${MAX_ACTIVE_BOTS} other bots are using Facebook right now — waiting for a free turn...`)
    try {
      while (!dir) {
        await interruptibleSleep(5000)
        dir = tryTakeSlot()
      }
    } catch (e) {
      if (onStopWhileWaiting) await onStopWhileWaiting()
      throw e
    }
  }
  try {
    return await fn()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
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

// Login form, "Continue as <name>" screen or checkpoint — the session is gone
async function isLoggedOut(page) {
  if (/facebook\.com\/(login|checkpoint)\b/i.test(page.url())) return true
  try {
    return await page.evaluate(() => {
      if (document.querySelector('input[name="pass"]')) return true
      for (const el of document.querySelectorAll('[role="button"], button, a')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (t === 'use another profile' || t === 'create new account') return true
      }
      return false
    })
  } catch {
    return false
  }
}

// Stop instead of failing every post; the claimed post goes back to the queue
async function stopForLogin(itemId = null) {
  console.log('\n❌ Facebook logged this account out.')
  console.log('   Use "Open Remote Re-login" in the dashboard, then start the bot again.')
  if (itemId) await requeueItem(itemId, 'Waiting: the bot account was logged out of Facebook')
  await safeCleanupRuntime()
  cleanPhotoCache()
  if (BOT_ACCOUNT_ID && !(await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'needs_login' }))) {
    await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
  }
  process.exit(EXIT_NEEDS_LOGIN)
}

async function recoverRuntimeAfterBrowserDeath() {
  console.log('   ♻️ Browser/page was closed. Rebuilding session...')
  await createFreshRuntime()

  const page = CURRENT_PAGE
  await openPage(page, 'https://www.facebook.com/')
  await page.bringToFront()
  await interruptibleSleep(2000)

  if (await isLoggedOut(page)) throw new Error('LOGGED_OUT')

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

  BOT_NAME = cfg.name || BOT_NAME
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

  let page
  const loggedOut = await withBrowserSlot(async () => {
    await createFreshRuntime()
    page = CURRENT_PAGE

    console.log('🔍 Verifying session...')
    await openPage(page, 'https://www.facebook.com/')
    await page.bringToFront()
    await interruptibleSleep(3000)
    return isLoggedOut(page)
  })

  if (loggedOut) await stopForLogin()
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

      if (await allPendingBlockedForMe()) {
        console.log(`\n⏸️  The ${counts.pending} post(s) left are in groups this account can't post in yet`)
        console.log('   (join requested, membership questions, or pending-post limit) — ending this campaign run.')
        console.log('   They stay in the queue for other bots, or for this bot once the group lets it post.')
        break
      }

      console.log('ℹ️ No due items right now — waiting')
      await interruptibleSleep(EMPTY_QUEUE_POLL_MS, 'next available post')
      continue
    }

    console.log(`\n📤 [${todayCount + 1}/${runtime.effectiveMaxPostsPerDay}] → ${item.groups.name}`)
    if (item.message) {
      console.log(`   Message: ${messagePreview(item.message.text)}`)
    } else {
      console.log(`   Listing: ${item.properties?.title}${item.properties?.code ? ` (${item.properties.code})` : ''}`)
    }

    let result
    let recovered = false
    const stopForSafety = await withBrowserSlot(async () => {
      page = await ensureLivePage()

      try {
        result = await postToGroup(page, item, uiProfile)

        if (result === 'REBUILD_AND_RETRY') {
          browserDeathCount++

          if (browserDeathCount >= 3) {
            console.log('   ❌ Browser session lost repeatedly. Bot stopped for safety.')
            await markItem(item.id, 'failed', 'Browser session lost repeatedly')
            if (BOT_ACCOUNT_ID) await dbUpdate('bot_accounts', BOT_ACCOUNT_ID, { status: 'error' })
            return true
          }

          recovered = true
          page = await recoverRuntimeAfterBrowserDeath()
          result = await postToGroup(page, item, uiProfile, true)
          if (result === 'REBUILD_AND_RETRY') result = false
        }
      } catch (e) {
        if (e.message === 'LOGGED_OUT') await stopForLogin(item.id)
        if (e.message === 'BOT_STOPPED' || !recovered) throw e
        console.log(`   ❌ Browser recovery failed: ${e.message}`)
        _postError = `Browser recovery failed: ${e.message}`
        result = false
      }
      return false
    }, () => requeueItem(item.id, 'Bot stopped before posting'))
    if (stopForSafety) break

    if (isPostSuccess(result)) {
      browserDeathCount = 0
      await markItem(item.id, 'posted', result.note || null)
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

      console.log(`   ✅ Posted${recovered ? ' after recovery' : ''}! (${todayCount}/${runtime.effectiveMaxPostsPerDay} today)`)
    } else if (result?.requeue || result?.skipped) {
      // Nothing was posted — no full post delay, just a short human-like pause
      if (result.requeue) {
        await requeueItem(item.id, result.note)
        console.log(`   ↩️ ${result.note} — post returned to the queue`)
      } else {
        await markItem(item.id, 'skipped', result.note)
        console.log(`   ⏭️ ${result.note} — post skipped`)
      }
      if (STOP_REQUESTED) throw new Error('BOT_STOPPED')
      await interruptibleSleep(randomBetween(60000, 120000), 'next group')
      continue
    } else {
      const reason = recovered
        ? `After browser recovery: ${_postError || 'could not complete post'}`
        : _postError || 'Bot could not complete post'
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
  // Once Post is clicked the listing may be live — never report failure or retry after that
  let postClicked = false

  const text   = item.message ? item.message.text.trim() : buildText(item)
  const propId = item.properties?.id
  const media  = item.message ? [] : collectPropertyMedia(item.properties || {})
  const propLabel  = item.message
    ? `"💬 ${messagePreview(item.message.text)}" → ${item.groups?.name}`
    : `"${item.properties?.title || propId}${item.properties?.code ? ` ${item.properties.code}` : ''}" → ${item.groups?.name}`

  // Guard: skip post if there is no text to type
  if (!text || text.trim().length < 5) {
    logPostError('No post body — raw_description is empty or missing', propLabel)
    return false
  }

  try {
    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    page = await ensureLivePage()

    console.log(`   🌐 Opening group${isRetry ? ' (retry)' : ''}...`)
    await openPage(page, item.groups.fb_url)
    await page.bringToFront()
    await interruptibleSleep(randomBetween(3000, 5000))

    try {
      await page.keyboard.press('Escape')
      await interruptibleSleep(500)
    } catch {}

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    if (await isLoggedOut(page)) throw new Error('LOGGED_OUT')

    console.log('   🖊️ Opening composer...')
    if (!(await openComposer(page, uiProfile))) {
      // Work out why: not a member, join pending, pending-post limit, sell-form only…
      const blocked = await handleNoComposer(page, item, uiProfile)
      if (blocked !== null) return blocked
    }

    await interruptibleSleep(randomBetween(1500, 2500))

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    console.log('   ✍️ Typing text...')
    COMPOSER_LOCATOR = null
    if (!(await typeText(page, text, uiProfile))) {
      logPostError('Could not type text into composer (text did not match after retry — not posted)', propLabel)
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

    if (!(await composerStillMatches(text))) {
      logPostError('Composer text changed before posting — not posted', propLabel)
      return false
    }

    console.log('   🖱️ Clicking Post...')
    if (!(await clickPost(page, uiProfile))) {
      await page.screenshot({ path: join(__dir, `debug_post_${Date.now()}.png`) })
      logPostError('Post button did not respond', propLabel)
      return false
    }
    postClicked = true

    // Facebook can't confirm a post right away (admin approval etc.), so once Post
    // is clicked it counts as posted. Only note when the composer didn't close.
    let note = null
    if (!(await waitForComposerClosed(30000))) {
      if (await closeParticipationReview(page)) {
        note = 'Posted — group asked membership questions afterwards (answer them on Facebook)'
        await setGroupAccess(item.groups?.id, 'needs_manual_join', { note: 'Answer the group\'s participation questions' })
      } else {
        note = 'Post clicked but the composer stayed open — check the group'
      }
      console.log(`   ⚠️ ${note}`)
    } else {
      console.log('   ✅ Facebook accepted the post')
      await setGroupAccess(item.groups?.id, 'member')
    }

    try {
      await openPage(page, 'https://www.facebook.com/', { retry: false })
      await interruptibleSleep(1500)
    } catch (e) {
      if (e.message === 'BOT_STOPPED') return { ok: true, note }
      console.log(`   ⚠️ Could not return to home page (${String(e.message).split('\n')[0]}) — continuing`)
    }

    return { ok: true, note }
  } catch (err) {
    const firstLine = String(err.message || err).split('\n')[0]
    if (postClicked) {
      // Never retry or fail a post that may already be live (would duplicate it)
      console.log(`   ⚠️ Error after clicking Post [${propLabel}]: ${firstLine} — marked posted, please check the group`)
      if (err.message === 'BOT_STOPPED') STOP_REQUESTED = true
      return { ok: true, note: `Post was submitted but not confirmed (${firstLine}) — check the group` }
    }
    if (err.message === 'BOT_STOPPED' || err.message === 'LOGGED_OUT') throw err
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
      .filter({ hasText: /write something|what.s on your mind|start (a )?discussion/i })
      .first()
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click()
      return true
    }
  } catch {}

  return false
}

// ── Why the composer didn't open ──────────────────────────
// Reads the group page: Join / Cancel request buttons, "Sell Something" form,
// Discussion tab, and the "at the limit for pending content" notice.
async function readGroupState(page) {
  try {
    return await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      const items = [...document.querySelectorAll('[role="button"], button, [role="tab"], a')]
        .filter(el => el.getClientRects().length > 0)
        .map(el => ({ el, t: norm(el.textContent), l: norm(el.getAttribute('aria-label')) }))
      const has = (...names) => items.some(x => names.includes(x.t) || names.includes(x.l))
      const isTab = x => x.el.getAttribute('role') === 'tab' || x.el.tagName === 'A'
      const discussion = items.find(x => isTab(x) && (x.t === 'discussion' || x.t === 'discussions'))
      const body = norm(document.body?.innerText).replace(/[‘’]/g, "'")
      return {
        loggedOut: !!document.querySelector('input[name="pass"]') || has('use another profile'),
        joinButton: has('join group'),
        requested: has('cancel request', 'requested'),
        sellButton: has('sell something'),
        discussionTab: !!discussion,
        discussionSelected: !!discussion && discussion.el.getAttribute('aria-selected') === 'true',
        // Tabs that don't fit are hidden under "More" — Discussion could be in there
        moreTabs: items.some(x => x.t === 'more' && (x.el.getAttribute('role') === 'tab' || x.el.getAttribute('aria-haspopup'))),
        pendingLimit: body.includes('at the limit for pending content'),
        // Private, deleted, or this account was blocked/removed
        unavailable: body.includes("content isn't available"),
        // Still on the Facebook logo splash — nothing clickable yet
        loading: items.length < 5,
      }
    })
  } catch {
    return {}
  }
}

async function clickDiscussionTab(page) {
  try {
    return await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      for (const el of document.querySelectorAll('[role="tab"], a')) {
        if (el.getClientRects().length && ['discussion', 'discussions'].includes(norm(el.textContent))) {
          el.click()
          return true
        }
      }
      return false
    })
  } catch {
    return false
  }
}

// Returns null when the composer is open after all, otherwise the post's outcome:
// { requeue, note } — another bot (or this one, later) can post it
// { skipped, note } — the group was turned off
// false             — unknown problem (_postError set, screenshot saved)
async function handleNoComposer(page, item, uiProfile) {
  const groupId = item.groups?.id
  let state = await readGroupState(page)
  let reloaded = false

  if (state.loading) {
    console.log('   ⏳ Group page still loading — reloading once')
    if (await reloadAndOpenComposer(page, uiProfile)) return null
    reloaded = true
    state = await readGroupState(page)
  }

  if (state.loggedOut) throw new Error('LOGGED_OUT')

  if (state.unavailable) {
    await setGroupAccess(groupId, 'needs_manual_join', {
      retryMs: 7 * 24 * HOUR_MS,
      note: "Group isn't available to this account (private, deleted, or blocked)",
    })
    return { requeue: true, note: `Waiting: group isn't available to ${BOT_NAME} — another bot will post it` }
  }

  if (state.pendingLimit) return await pendingLimitReached(groupId)

  if (state.joinButton && !(state.sellButton && !state.discussionTab)) return await joinGroup(page, item)

  if (state.requested) {
    await setGroupAccess(groupId, 'join_pending', { retryMs: 6 * HOUR_MS, note: 'Join request waiting for admin approval' })
    return { requeue: true, note: `Waiting: ${BOT_NAME}'s join request is pending admin approval` }
  }

  if (state.discussionTab && !state.discussionSelected) {
    console.log('   💬 No composer here — trying the Discussion tab')
    if (await clickDiscussionTab(page)) {
      await interruptibleSleep(randomBetween(3000, 5000))
      if (await openComposer(page, uiProfile)) return null
      state = await readGroupState(page)
      if (state.pendingLimit) return await pendingLimitReached(groupId)
    }
  }

  // Only a "Sell Something" form and no Discussion tab → turn the group off.
  // Strict: re-check after a reload, and never when tabs are hidden under "More".
  if (state.sellButton && !state.discussionTab && !state.moreTabs) {
    console.log('   🔎 Only a "Sell Something" form — re-checking before turning the group off')
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    await interruptibleSleep(randomBetween(4000, 6000))
    const again = await readGroupState(page)
    if (again.sellButton && !again.discussionTab && !again.moreTabs && !(await openComposer(page, uiProfile))) {
      const note = 'Group turned off: only allows Sell forms (no Discussion tab)'
      await disableGroup(groupId, 'sale_form_only', note)
      console.log(`   🚫 "${item.groups?.name}" only allows Sell forms — group turned off`)
      return { skipped: true, note }
    }
    if (again.discussionTab || again.moreTabs) console.log('   ℹ️ Re-check found more tabs — group left on')
  }

  if (!reloaded) {
    console.log('   🔄 Composer still not found — reloading once')
    if (await reloadAndOpenComposer(page, uiProfile)) return null
  }

  // Unknown reason: skip this group for this bot for a day and let another bot try
  await page.screenshot({ path: join(__dir, `debug_composer_${Date.now()}.png`) }).catch(() => {})
  await setGroupAccess(groupId, 'needs_manual_join', {
    retryMs: 24 * HOUR_MS,
    note: 'Composer did not open (unknown reason) — open the group with this account to check',
  })
  return { requeue: true, note: `Waiting: composer did not open for ${BOT_NAME} — another bot will post it` }
}

async function reloadAndOpenComposer(page, uiProfile) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (e) {
    if (isClosedTargetError(e)) throw e
  }
  await interruptibleSleep(randomBetween(5000, 7000))
  try { await page.keyboard.press('Escape') } catch {}
  return await openComposer(page, uiProfile)
}

// Some groups show "Participation review" questions right after a post is submitted
async function closeParticipationReview(page) {
  try {
    return await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find(d => /participation review|answering these questions/i.test(d.textContent || ''))
      if (!dialog) return false
      dialog.querySelector('[aria-label="Close"]')?.click()
      return true
    })
  } catch {
    return false
  }
}

async function pendingLimitReached(groupId) {
  await setGroupAccess(groupId, 'pending_limit', {
    retryMs: 24 * HOUR_MS,
    note: "At Facebook's limit for posts awaiting admin approval",
  })
  return { requeue: true, note: `Waiting: ${BOT_NAME} has too many posts awaiting admin approval in this group` }
}

// Membership-question / group-rules dialog shown after clicking "Join group"
async function readJoinDialog(page) {
  try {
    return await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (!d.getClientRects().length) continue
        const text = norm(d.innerText)
        if (!/question|rules|submit|join/.test(text)) continue // e.g. a Messenger chat box
        const inputs = d.querySelectorAll(
          'textarea, input[type="text"], input:not([type]), input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [contenteditable="true"]'
        ).length
        const agree = [...d.querySelectorAll('[role="button"], button')].some(b => ['i agree', 'agree'].includes(norm(b.textContent)))
        return { open: true, hasQuestions: inputs > 0 || /membership questions|answer questions/.test(text), agree }
      }
      return { open: false }
    })
  } catch {
    return { open: false }
  }
}

async function clickInDialog(page, names) {
  try {
    return await page.evaluate((names) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      for (const b of document.querySelectorAll('[role="dialog"] [role="button"], [role="dialog"] button')) {
        if (b.getClientRects().length && (names.includes(norm(b.textContent)) || names.includes(norm(b.getAttribute('aria-label'))))) {
          b.click()
          return true
        }
      }
      return false
    }, names)
  } catch {
    return false
  }
}

async function joinGroup(page, item) {
  const groupId = item.groups?.id

  if ((await joinsToday()) >= MAX_JOINS_PER_DAY) {
    await setGroupAccess(groupId, 'not_member', {
      retryMs: msUntilTomorrow(),
      note: `Daily join limit (${MAX_JOINS_PER_DAY}) reached — will join tomorrow`,
    })
    return { requeue: true, note: `Waiting: ${BOT_NAME} isn't in this group (daily join limit reached, joins tomorrow)` }
  }

  console.log('   🙋 Not a member — clicking "Join group"')
  const clicked = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    for (const b of document.querySelectorAll('[role="button"], button')) {
      if (b.getClientRects().length && (norm(b.textContent) === 'join group' || norm(b.getAttribute('aria-label')) === 'join group')) {
        b.click()
        return true
      }
    }
    return false
  }).catch(() => false)

  if (!clicked) {
    await setGroupAccess(groupId, 'needs_manual_join', { retryMs: 24 * HOUR_MS, note: 'Could not click "Join group"' })
    return { requeue: true, note: `Waiting: ${BOT_NAME} isn't in this group — join it manually` }
  }

  // Counts toward the daily join cap even if the outcome is unclear
  await setGroupAccess(groupId, 'not_member', { joined: true, note: 'Clicked "Join group"' })
  await interruptibleSleep(randomBetween(3000, 5000))

  const dialog = await readJoinDialog(page)
  if (dialog.open && dialog.hasQuestions) {
    // Never invent answers — close it and leave the group for a person to join
    console.log('   📝 Group asks membership questions — leaving them for a person')
    if (!(await clickInDialog(page, ['close']))) await page.keyboard.press('Escape').catch(() => {})
    await interruptibleSleep(2000)
  } else if (dialog.open && dialog.agree) {
    console.log('   📜 Agreeing to group rules')
    await clickInDialog(page, ['i agree', 'agree'])
    await interruptibleSleep(randomBetween(2000, 3000))
  }

  const after = await readGroupState(page)
  if (after.requested) {
    await setGroupAccess(groupId, 'join_pending', { retryMs: 6 * HOUR_MS, note: 'Join request waiting for admin approval' })
    console.log('   ⏳ Join requested — waiting for admin approval')
    return { requeue: true, note: `Waiting: ${BOT_NAME} asked to join this group (admin approval pending)` }
  }
  if (!after.joinButton && !dialog.hasQuestions) {
    await setGroupAccess(groupId, 'member', { note: 'Joined by bot' })
    console.log('   ✅ Joined the group — the post will be retried shortly')
    return { requeue: true, note: `Waiting: ${BOT_NAME} just joined this group — posting shortly` }
  }

  const note = dialog.hasQuestions
    ? 'Group asks membership questions — join it manually from this account'
    : 'Join did not go through — join it manually from this account'
  await setGroupAccess(groupId, 'needs_manual_join', { retryMs: 24 * HOUR_MS, note })
  return { requeue: true, note: `Waiting: ${BOT_NAME} — ${note}` }
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

  const candidates = []
  if (uiProfile?.textbox_selector) {
    const locator = await findProfileLocator(page, uiProfile.textbox_selector, 2500)
    if (locator) candidates.push({ locator, label: 'trained selector' })
  }
  for (const sel of ['[role="dialog"] [role="textbox"]', '[role="dialog"] [contenteditable="true"]']) {
    candidates.push({ locator: page.locator(sel).first(), label: sel })
  }

  for (const { locator, label } of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 6000 })
      if (((await locator.getAttribute('aria-label')) || '').toLowerCase().includes('comment')) continue
      const { ok } = await fillComposer(page, locator, text)
      if (ok) {
        console.log(`   🎯 Text typed and verified (${label})`)
        COMPOSER_LOCATOR = locator
        return true
      }
      // Leave the box empty so the next candidate can't stack a second copy
      await clearComposer(page, locator).catch(() => {})
    } catch {}
  }

  return false
}

async function waitForComposerClosed(timeoutMs) {
  if (!COMPOSER_LOCATOR) return false
  try {
    await COMPOSER_LOCATOR.waitFor({ state: 'hidden', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

// Re-check the composer right before clicking Post (media upload can disturb it)
async function composerStillMatches(text) {
  if (!COMPOSER_LOCATOR) return false
  try {
    return composerTextMatches(text, await readComposerText(COMPOSER_LOCATOR))
  } catch {
    return false
  }
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

function messagePreview(text, max = 50) {
  const first = String(text || '').split('\n').find(l => l.trim()) || ''
  return first.length > max ? `${first.slice(0, max)}…` : first
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
