// login.js — Facebook session saver
// Called by server.js with BOT_ACCOUNT_ID and SESSION_FILE env vars

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'

const __dir    = dirname(fileURLToPath(import.meta.url))
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

async function main() {
  const botId      = process.env.BOT_ACCOUNT_ID
  const sessionFile = process.env.SESSION_FILE || join(__dir, 'fb_session.json')

  // Fetch bot credentials from Supabase
  const { data: bot } = await supabase.from('bot_accounts').select('*').eq('id', botId).single()
  if (!bot) { console.error('❌ Bot not found'); process.exit(1) }

  console.log(`\n🔐 Logging in ${bot.name} (${bot.fb_email})`)

  const userDataDir = sessionFile.replace('.json', '_profile')

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Force window to front on macOS
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  })

  const page = await context.newPage()

  // Hide automation signals
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] })
  })

  // Check if already logged in using existing profile
  console.log('🔍 Checking existing session...')
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
  await sleep(2000)

  // Bring window to front (macOS)
  await page.bringToFront()

  const existingCookies = await context.cookies('https://www.facebook.com')
  const alreadyLoggedIn = existingCookies.some(c => c.name === 'c_user') &&
                          existingCookies.some(c => c.name === 'xs')

  if (alreadyLoggedIn) {
    console.log('✅ Already logged in from existing profile — refreshing session file')
    await saveSession(context, sessionFile, bot)
    await context.close()
    return
  }

  // Need to log in — go directly to login page
  await page.goto('https://www.facebook.com/login/', { waitUntil: 'domcontentloaded', timeout: 15000 })
  await sleep(2000)
  await page.bringToFront()

  // Accept cookies if shown
  try {
    for (const text of ['Allow all cookies', 'Accept all', 'Only allow essential cookies']) {
      const btn = page.locator(`button:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click()
        await sleep(1000)
        break
      }
    }
  } catch {}

  // Try auto-fill — handle multiple possible login form layouts
  let filled = false

  // Layout 1: Standard #email / #pass
  try {
    const emailField = page.locator('#email, input[name="email"], input[type="email"]').first()
    await emailField.waitFor({ state: 'visible', timeout: 8000 })
    await emailField.click()
    await sleep(randomBetween(300, 600))
    await emailField.fill('')
    await page.keyboard.type(bot.fb_email, { delay: randomBetween(50, 100) })
    await sleep(randomBetween(400, 700))

    const passField = page.locator('#pass, input[name="pass"], input[type="password"]').first()
    await passField.click()
    await sleep(randomBetween(300, 500))
    await passField.fill('')
    await page.keyboard.type(bot.fb_password, { delay: randomBetween(50, 100) })
    await sleep(randomBetween(500, 900))

    // Click login button
    const loginBtn = page.locator('[name="login"], button[type="submit"], input[type="submit"]').first()
    await loginBtn.click()
    filled = true
    console.log('📧 Credentials submitted automatically')
  } catch (e) {
    console.log(`⚠️  Auto-fill failed: ${e.message.split('\n')[0]}`)
  }

  // Layout 2: Mobile-style form (sometimes shown)
  if (!filled) {
    try {
      const emailField = page.locator('input[autocomplete="username"], input[autocomplete="email"]').first()
      await emailField.waitFor({ state: 'visible', timeout: 5000 })
      await emailField.fill(bot.fb_email)
      await sleep(500)
      await page.keyboard.press('Enter')
      await sleep(1000)
      const passField = page.locator('input[type="password"]').first()
      await passField.fill(bot.fb_password)
      await sleep(500)
      await page.keyboard.press('Enter')
      filled = true
      console.log('📧 Credentials submitted (mobile layout)')
    } catch {}
  }

  if (!filled) {
    console.log('\n👀 BROWSER WINDOW IS OPEN ON YOUR SCREEN')
    console.log('   Look for a Chrome window — it may be behind other apps')
    console.log('   On Mac: press Cmd+Tab to switch apps and find Chrome')
    console.log('   Please log in manually — you have 2 minutes\n')
  } else {
    console.log('\n👀 A browser window is open — complete any 2FA or CAPTCHA if shown')
    console.log('   On Mac: press Cmd+Tab to find the Chrome window\n')
  }

  // Poll for successful login
  let loggedIn = false
  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    const cookies = await context.cookies('https://www.facebook.com')
    if (cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs')) {
      loggedIn = true
      break
    }
    if (i === 5)  console.log('   ⏳ Waiting for login...')
    if (i === 15) console.log('   ⏳ Still waiting... complete 2FA in the browser if needed')
    if (i === 25) console.log('   ⏳ Last chance — 45 seconds remaining')
  }

  if (!loggedIn) {
    console.log('❌ Login timed out. Please try again.')
    await supabase.from('bot_accounts').update({ status: 'error' }).eq('id', botId)
    await context.close()
    process.exit(1)
  }

  await sleep(2000)
  await saveSession(context, sessionFile, bot)
  await context.close()
}

async function saveSession(context, sessionFile, bot) {
  const cookies = await context.cookies('https://www.facebook.com')
  writeFileSync(sessionFile, JSON.stringify({ cookies }, null, 2))
  await supabase.from('bot_accounts').update({
    status: 'idle',
    last_active: new Date().toISOString()
  }).eq('id', bot.id)
  console.log(`\n✅ Session saved (${cookies.length} cookies) → ${sessionFile}`)
  console.log('   Bot is ready — click "Start Posting" in the dashboard!')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min)) }

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1) })
