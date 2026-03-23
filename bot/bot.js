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

const __dir = dirname(fileURLToPath(import.meta.url))

const SESSION_FILE = process.env.SESSION_FILE || join(__dir, 'fb_session.json')
const BOT_ACCOUNT_ID = process.env.BOT_ACCOUNT_ID || null
const CAMPAIGN_ID = process.env.CAMPAIGN_ID

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

let STOP_REQUESTED = false
let CURRENT_CONTEXT = null
let CURRENT_PAGE = null
let _cdTimer = null

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
  } catch (e) {
    console.log(`   ⚠️ DB update failed: ${e.message}`)
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
function startCountdown(ms, label) {
  stopCountdown()
  const end = Date.now() + ms

  const tick = () => {
    if (STOP_REQUESTED) {
      stopCountdown()
      return
    }

    const rem = end - Date.now()
    if (rem <= 0) {
      stopCountdown()
      return
    }

    const m = Math.floor(rem / 60000)
    const s = Math.floor((rem % 60000) / 1000)
    console.log(`⏳ ${label} — ${m}m ${s}s remaining`)
  }

  tick()
  _cdTimer = setInterval(tick, 30000)
}

function stopCountdown() {
  clearInterval(_cdTimer)
  _cdTimer = null
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
    const { data } = await supabase
      .from('post_queue')
      .select('properties(id, photos)')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')

    if (!data?.length) return

    const seen = new Set()
    const toDownload = []

    for (const row of data) {
      const p = row.properties
      if (!p) continue

      if (!seen.has(p.id)) {
        console.log(
          `   📋 Property ${p.id?.slice(0, 8)}: photos=${JSON.stringify(
            p.photos?.slice(0, 1)
          )} (${p.photos?.length || 0} total)`
        )
      }

      if (!p || seen.has(p.id) || !p.photos?.length) continue
      seen.add(p.id)
      toDownload.push(p)
    }

    if (!toDownload.length) {
      console.log('   ℹ️ No photos found for any property in this campaign')
      return
    }

    if (!existsSync(PHOTO_DIR)) mkdirSync(PHOTO_DIR, { recursive: true })
    console.log(`\n📥 Pre-downloading photos for ${toDownload.length} propert(y/ies)...`)

    for (const prop of toDownload) {
      if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

      for (let i = 0; i < Math.min(prop.photos.length, 4); i++) {
        const url = prop.photos[i]
        if (!url) continue

        const localPath = getPhotoPath(prop.id, i, url)
        if (existsSync(localPath)) continue

        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
          console.log(`   ✅ Cached: ${localPath.split('/').pop()}`)
        } catch (e) {
          console.log(`   ⚠️ Could not cache photo ${i + 1} for ${prop.id}: ${e.message}`)
        }
      }
    }

    console.log('📦 Photo cache ready\n')
  } catch (e) {
    if (e.message === 'BOT_STOPPED') return
    console.log(`⚠️ Photo cache warm failed: ${e.message}`)
  }
}

function getPhotoPath(propId, index, url) {
  const urlPath = (url || '').split('?')[0]
  const ext = ['jpg', 'jpeg', 'png', 'webp'].includes(urlPath.split('.').pop()?.toLowerCase())
    ? urlPath.split('.').pop().toLowerCase()
    : 'jpg'
  return join(PHOTO_DIR, `${propId}_${index}.${ext}`)
}

function getCachedPhotos(propId, photos) {
  const paths = []
  for (let i = 0; i < Math.min((photos || []).length, 4); i++) {
    const p = getPhotoPath(propId, i, photos[i])
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
      .select(`
        id,
        campaign_id,
        duplicate_warned,
        status,
        assigned_bot_id,
        properties(id,title,description,rent,deposit,locality,phone,whatsapp_link,photos),
        groups(id,name,fb_url)
      `)
      .eq('id', claimedId)
      .single()

    if (error) {
      console.log(`   ⚠️ Fetch claimed item failed: ${error.message}`)
      return null
    }

    return data
  } catch (e) {
    console.log(`   ⚠️ getNextItem failed: ${e.message}`)
    return null
  }
}

async function campaignHasRemainingWork() {
  try {
    const { count, error } = await supabase
      .from('post_queue')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', CAMPAIGN_ID)
      .in('status', ['pending', 'processing'])

    if (error) {
      console.log(`   ⚠️ Remaining work check failed: ${error.message}`)
      return false
    }

    return (count || 0) > 0
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
  console.log(`   Campaign:  ${CAMPAIGN_ID}`)
  console.log(`   Effective Max/day: ${runtime.effectiveMaxPostsPerDay}`)
  console.log(`   Effective Window:  ${runtime.effectiveStartHour}:00 – ${runtime.effectiveEndHour}:00`)
  console.log(`   Bot Max/day:       ${runtime.botMax}`)
  console.log(`   Bot Window:        ${runtime.botStart}:00 – ${runtime.botEnd}:00`)
  console.log(`   Campaign Max/day:  ${runtime.campaignMax}`)
  console.log(`   Campaign Window:   ${runtime.campaignStart}:00 – ${runtime.campaignEnd}:00`)
  console.log(`   Delay:             ${cfg.min_delay_seconds}s – ${cfg.max_delay_seconds}s`)
  console.log(`   UI profile:        ${uiProfile ? 'trained selectors loaded' : 'using fallback selectors'}\n`)

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
      const hasRemaining = await campaignHasRemainingWork()

      if (!hasRemaining) {
        console.log('🎉 All posts complete!')
        await dbUpdate('campaigns', CAMPAIGN_ID, { status: 'completed' })
        console.log('✅ Campaign marked as completed')
      } else {
        console.log('ℹ️ No unclaimed items left for this bot right now')
      }

      break
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

        if (retrySuccess === true) {
          browserDeathCount = 0
          await markItem(item.id, 'posted')
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
          await markItem(item.id, 'failed', 'Bot could not complete post after browser recovery')
          console.log('   ❌ Failed after recovery — moving to next')
        }
      } catch (e) {
        await markItem(item.id, 'failed', `Browser recovery failed: ${e.message}`)
        console.log(`   ❌ Browser recovery failed: ${e.message}`)
      }
    } else if (success) {
      browserDeathCount = 0
      await markItem(item.id, 'posted')
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
      await markItem(item.id, 'failed', 'Bot could not complete post')
      console.log('   ❌ Failed — moving to next')
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

// ── Post to one group ─────────────────────────────────────
async function postToGroup(page, item, uiProfile, isRetry = false) {
  const text = buildText(item)
  const propId = item.properties?.id
  const photos = item.properties?.photos || []

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
      await page.screenshot({ path: join(__dir, `debug_${Date.now()}.png`) })
      return false
    }

    await interruptibleSleep(randomBetween(1500, 2500))

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    console.log('   ✍️ Typing text...')
    if (!(await typeText(page, text, uiProfile))) {
      console.log('   ⚠️ Could not type text')
      return false
    }

    await interruptibleSleep(randomBetween(800, 1200))

    if (photos.length > 0 && propId) {
      const cachedPaths = getCachedPhotos(propId, photos)
      console.log(`   🖼️ Cached photos for ${propId?.slice(0, 8)}: ${cachedPaths.length} file(s)`)

      if (cachedPaths.length > 0) {
        await attachPhotos(page, cachedPaths, uiProfile)
        await interruptibleSleep(randomBetween(2000, 3000))
      } else {
        console.log('   ⚠️ No cached photos found — posting text only')
        console.log(`   📁 Looking in: ${PHOTO_DIR}`)
      }
    }

    if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

    console.log('   🖱️ Clicking Post...')
    if (!(await clickPost(page, uiProfile))) {
      await page.screenshot({ path: join(__dir, `debug_post_${Date.now()}.png`) })
      return false
    }

    await interruptibleSleep(randomBetween(3000, 5000))
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await interruptibleSleep(1500)

    return true
  } catch (err) {
    if (err.message === 'BOT_STOPPED') throw err
    if (isClosedTargetError(err)) {
      console.log(`   ⚠️ Error: ${String(err.message).split('\n')[0]}`)
      return 'REBUILD_AND_RETRY'
    }
    console.log(`   ⚠️ Error: ${String(err.message).split('\n')[0]}`)
    return false
  }
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

async function attachPhotos(page, localPaths, uiProfile) {
  if (!localPaths?.length) return
  if (STOP_REQUESTED) throw new Error('BOT_STOPPED')

  console.log(`   📎 Attaching: ${localPaths.map((p) => p.split('/').pop()).join(', ')}`)

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
    console.log('   ⚠️ Photo button not found in composer — skipping photos')
    return
  }

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      photoButtonEl.click(),
    ])
    await fileChooser.setFiles(localPaths)
    await interruptibleSleep(randomBetween(3000, 5000))
    console.log(`   ✅ ${localPaths.length} photo(s) attached via file chooser`)
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
      console.log(`   ✅ ${localPaths.length} photo(s) attached via hidden input`)
      return
    }
  } catch (e) {
    console.log(`   ⚠️ Hidden input strategy failed: ${String(e.message).split('\n')[0]}`)
  }

  console.log('   ⚠️ Could not attach photos — posting text only')
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
        await page.keyboard.type(text, { delay: randomBetween(25, 65) })
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
      await page.keyboard.type(text, { delay: randomBetween(25, 65) })
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
  let t = p.description || p.title || ''
  t = t.replace(/\{phone\}/g, p.phone || '')
  t = t.replace(/\{whatsapp_link\}/g, p.whatsapp_link || '')
  t = t.replace(/\{locality\}/g, p.locality || '')
  t = t.replace(/\{rent\}/g, p.rent ? '₹' + Number(p.rent).toLocaleString('en-IN') : '')
  t = t.replace(/\{deposit\}/g, p.deposit ? '₹' + Number(p.deposit).toLocaleString('en-IN') : '')
  return t
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