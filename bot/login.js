// login.js — Facebook session saver + UI training
// Called by server.js with BOT_ACCOUNT_ID and SESSION_FILE env vars

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'

const __dir = dirname(fileURLToPath(import.meta.url))
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const TRAINING_GROUP_URL =
  process.env.TRAINING_GROUP_URL || 'https://www.facebook.com/groups/740033105526357'

async function main() {
  const botId = process.env.BOT_ACCOUNT_ID
  const sessionFile = process.env.SESSION_FILE || join(__dir, 'fb_session.json')

  const { data: bot } = await supabase.from('bot_accounts').select('*').eq('id', botId).single()
  if (!bot) {
    console.error('❌ Bot not found')
    process.exit(1)
  }

  console.log(`\n🔐 Logging in ${bot.name} (${bot.fb_email})`)

  const userDataDir = sessionFile.replace('.json', '_profile')

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
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
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] })
  })

  console.log('🔍 Checking existing session...')
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
  await sleep(2000)
  await page.bringToFront()

  const existingCookies = await context.cookies('https://www.facebook.com')
  const alreadyLoggedIn =
    existingCookies.some((c) => c.name === 'c_user') && existingCookies.some((c) => c.name === 'xs')

  if (!alreadyLoggedIn) {
    await page.goto('https://www.facebook.com/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    })
    await sleep(2000)
    await page.bringToFront()

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

    let filled = false

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

      const loginBtn = page.locator('[name="login"], button[type="submit"], input[type="submit"]').first()
      await loginBtn.click()
      filled = true
      console.log('📧 Credentials submitted automatically')
    } catch (e) {
      console.log(`⚠️ Auto-fill failed: ${e.message.split('\n')[0]}`)
    }

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
      console.log('\n👀 Please log in manually in the browser window. You have 2 minutes.\n')
    } else {
      console.log('\n👀 Complete any 2FA or CAPTCHA in the browser window.\n')
    }

    let loggedIn = false
    for (let i = 0; i < 40; i++) {
      await sleep(3000)
      const cookies = await context.cookies('https://www.facebook.com')
      if (cookies.some((c) => c.name === 'c_user') && cookies.some((c) => c.name === 'xs')) {
        loggedIn = true
        break
      }
      if (i === 5) console.log('⏳ Waiting for login...')
      if (i === 15) console.log('⏳ Still waiting... complete 2FA in the browser if needed')
      if (i === 25) console.log('⏳ Last chance... 45 seconds remaining')
    }

    if (!loggedIn) {
      console.log('❌ Login timed out. Please try again.')
      await supabase.from('bot_accounts').update({ status: 'error' }).eq('id', botId)
      await context.close()
      process.exit(1)
    }
  } else {
    console.log('✅ Existing logged-in profile found')
  }

  const trained = await runUiTraining(page, botId)
  if (!trained) {
    console.log('⚠️ UI training was not saved. Bot will still use fallback selectors.')
  }

  await sleep(1000)
  await saveSession(context, sessionFile, bot)
  await context.close()
}

async function runUiTraining(page, botId) {
  console.log('\n🧭 Starting UI training flow...')
  console.log(`   Opening training group: ${TRAINING_GROUP_URL}`)

  await page.goto(TRAINING_GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.bringToFront()
  await sleep(2500)

  const result = await page.evaluate(async (groupUrl) => {
    try {
      const old = document.getElementById('__fb-bot-training-root')
      if (old) old.remove()

      const steps = [
        { key: 'composer', label: 'Click the button that opens the post composer' },
        { key: 'textbox', label: 'Click the textbox where the post body is typed' },
        { key: 'photo', label: 'Click the photo upload button' },
        { key: 'post', label: 'Click the final post button (it will not actually post)' },
      ]

      const state = {
        idx: 0,
        captured: {
          composer: null,
          textbox: null,
          photo: null,
          post: null,
        },
      }

      const root = document.createElement('div')
      root.id = '__fb-bot-training-root'
      root.innerHTML = `
        <div id="__fb-bot-training-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-size:15px;font-weight:700;">Bot UI Training</div>
            <button id="__fb-bot-training-close" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;">×</button>
          </div>
          <div id="__fb-bot-training-step" style="font-size:13px;line-height:1.45;margin-bottom:10px;"></div>
          <div id="__fb-bot-training-progress" style="font-size:12px;opacity:.8;margin-bottom:12px;"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="__fb-bot-training-restart">Restart</button>
            <button id="__fb-bot-training-save" disabled>Save Training</button>
            <button id="__fb-bot-training-cancel">Cancel</button>
          </div>
        </div>
      `
      const style = document.createElement('style')
      style.textContent = `
        #__fb-bot-training-root {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483647;
          font-family: Arial, sans-serif;
        }
        #__fb-bot-training-card {
          width: 340px;
          background: rgba(17,24,39,.96);
          color: white;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 14px;
          box-shadow: 0 18px 40px rgba(0,0,0,.35);
          padding: 14px;
        }
        #__fb-bot-training-card button {
          border: none;
          border-radius: 10px;
          padding: 9px 12px;
          cursor: pointer;
          font-weight: 600;
        }
        #__fb-bot-training-restart, #__fb-bot-training-cancel {
          background: #374151;
          color: white;
        }
        #__fb-bot-training-save {
          background: #2563eb;
          color: white;
        }
        #__fb-bot-training-save:disabled {
          opacity: .5;
          cursor: not-allowed;
        }
        .__fb-bot-training-highlight {
          outline: 3px solid #60a5fa !important;
          outline-offset: 2px !important;
        }
      `
      document.documentElement.appendChild(style)
      document.documentElement.appendChild(root)

      const stepEl = document.getElementById('__fb-bot-training-step')
      const progressEl = document.getElementById('__fb-bot-training-progress')
      const restartBtn = document.getElementById('__fb-bot-training-restart')
      const saveBtn = document.getElementById('__fb-bot-training-save')
      const cancelBtn = document.getElementById('__fb-bot-training-cancel')
      const closeBtn = document.getElementById('__fb-bot-training-close')

      const clearHighlights = () => {
        document.querySelectorAll('.__fb-bot-training-highlight').forEach((el) => {
          el.classList.remove('__fb-bot-training-highlight')
        })
      }

      const safeText = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 120)

      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
        return String(value).replace(/["\\]/g, '\\$&')
      }

      const buildSelectorData = (el) => {
        const tagName = (el.tagName || '').toLowerCase()
        const role = el.getAttribute('role') || null
        const ariaLabel = el.getAttribute('aria-label') || null
        const contenteditable = el.getAttribute('contenteditable') || null
        const type = el.getAttribute('type') || null
        const text = safeText(el.textContent)

        const selectorCandidates = []

        if (ariaLabel && role) selectorCandidates.push(`[aria-label="${cssEscape(ariaLabel)}"][role="${cssEscape(role)}"]`)
        if (ariaLabel) selectorCandidates.push(`[aria-label="${cssEscape(ariaLabel)}"]`)
        if (tagName && role) selectorCandidates.push(`${tagName}[role="${cssEscape(role)}"]`)
        if (tagName && contenteditable === 'true') selectorCandidates.push(`${tagName}[contenteditable="true"]`)
        if (contenteditable === 'true') selectorCandidates.push(`[contenteditable="true"]`)
        if (tagName && type) selectorCandidates.push(`${tagName}[type="${cssEscape(type)}"]`)
        if (tagName) selectorCandidates.push(tagName)

        return {
          tagName,
          role,
          ariaLabel,
          text,
          contenteditable,
          type,
          selectorCandidates: [...new Set(selectorCandidates)].filter(Boolean),
        }
      }

      const updateUi = () => {
        const current = steps[state.idx]
        stepEl.textContent = current
          ? `Step ${state.idx + 1} of ${steps.length}: ${current.label}`
          : 'All steps captured. Click Save Training.'
      
        progressEl.innerHTML = steps
          .map((s, i) => {
            const status = state.captured[s.key] ? '✅' : i === state.idx ? '👉' : '•'
            return `<span style="display:inline-block;margin-right:10px;">${status} ${s.key}</span>`
          })
          .join('')
      
        saveBtn.disabled = !steps.every((s) => state.captured[s.key])
      }

      const finish = (payload) => {
        clearHighlights()
        window.__fbBotTrainingResult = payload
        document.removeEventListener('click', clickHandler, true)
        if (root?.remove) root.remove()
        if (style?.remove) style.remove()
        
      }

      const clickHandler = (event) => {
        const rootCard = document.getElementById('__fb-bot-training-card')
        if (rootCard && rootCard.contains(event.target)) return

        const current = steps[state.idx]
        if (!current) return

        const target = event.target instanceof Element ? event.target : null
        const el = target ? target.closest('*') : null
        if (!el) return


        clearHighlights()
        el.classList.add('__fb-bot-training-highlight')

        state.captured[current.key] = buildSelectorData(el)

        if (current.key === 'photo' || current.key === 'post') {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
        }

        state.idx += 1
        updateUi()

        console.log(`[training] captured step: ${current.key}`)
      }

      document.addEventListener('click', clickHandler, true)

      restartBtn.onclick = () => {
        state.idx = 0
        state.captured = { composer: null, textbox: null, photo: null, post: null }
        clearHighlights()
        updateUi()
        console.log('[training] restarted')
      }

      cancelBtn.onclick = () => finish({ saved: false })
      closeBtn.onclick = () => finish({ saved: false })

      saveBtn.onclick = () => {
        if (saveBtn.disabled) return
        finish({
          saved: true,
          training_group_url: groupUrl,
          composer_selector: state.captured.composer,
          textbox_selector: state.captured.textbox,
          photo_selector: state.captured.photo,
          post_selector: state.captured.post,
        })
      }

      updateUi()

      return await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (window.__fbBotTrainingResult) {
            clearInterval(timer)
            resolve(window.__fbBotTrainingResult)
          }
        }, 300)
      })
    } catch (e) {
      return { saved: false, error: e.message }
    }
  }, TRAINING_GROUP_URL)

  if (!result?.saved) return false

  const payload = {
    bot_account_id: botId,
    training_group_url: result.training_group_url,
    composer_selector: result.composer_selector,
    textbox_selector: result.textbox_selector,
    photo_selector: result.photo_selector,
    post_selector: result.post_selector,
    trained_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('bot_ui_profiles')
    .upsert(payload, { onConflict: 'bot_account_id' })

  if (error) {
    console.log(`⚠️ Could not save UI training: ${error.message}`)
    return false
  }

  console.log('✅ UI training saved')
  return true
}

async function saveSession(context, sessionFile, bot) {
  const cookies = await context.cookies('https://www.facebook.com')
  writeFileSync(sessionFile, JSON.stringify({ cookies }, null, 2))
  await supabase
    .from('bot_accounts')
    .update({
      status: 'idle',
      last_active: new Date().toISOString(),
    })
    .eq('id', bot.id)

  console.log(`\n✅ Session saved (${cookies.length} cookies) → ${sessionFile}`)
  console.log('Bot is ready.')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min))
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message)
  process.exit(1)
})


