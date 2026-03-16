// debug.js — Opens the group page visibly and prints all buttons/inputs
// Usage: node debug.js
// This helps us see exactly what Facebook is showing so we can fix the selectors

import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'fs'
import 'dotenv/config'

const SESSION_FILE = './fb_session.json'

async function debug() {
  if (!existsSync(SESSION_FILE)) {
    console.error('❌ No session. Run node login.js first.')
    process.exit(1)
  }

  const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))

  const browser = await chromium.launch({
    headless: false, // VISIBLE — watch what happens
    slowMo: 500,
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })

  await context.addCookies(session.cookies)
  const page = await context.newPage()

  // Go to the group
  const groupUrl = process.argv[2] || 'https://www.facebook.com/groups/1234' // pass URL as argument
  console.log(`\n🔍 Opening: ${groupUrl}`)
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(4000)

  // Take screenshot
  await page.screenshot({ path: './debug_group.png', fullPage: false })
  console.log('📸 Screenshot saved: debug_group.png')

  // Print all role="button" elements with their labels/text
  console.log('\n📋 All buttons on the page:')
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="button"]')].slice(0, 30).map(b => ({
      ariaLabel: b.getAttribute('aria-label') || '',
      placeholder: b.getAttribute('aria-placeholder') || '',
      text: b.textContent?.trim().slice(0, 60) || '',
      tag: b.tagName,
      visible: b.offsetWidth > 0 && b.offsetHeight > 0,
    }))
  })
  buttons.forEach((b, i) => {
    if (b.visible) console.log(`  [${i}] tag=${b.tag} label="${b.ariaLabel}" placeholder="${b.placeholder}" text="${b.text}"`)
  })

  // Print all contenteditable elements
  console.log('\n📋 All contenteditable elements:')
  const editors = await page.evaluate(() => {
    return [...document.querySelectorAll('[contenteditable]')].map(e => ({
      contenteditable: e.getAttribute('contenteditable'),
      ariaLabel: e.getAttribute('aria-label') || '',
      ariaPlaceholder: e.getAttribute('aria-placeholder') || '',
      role: e.getAttribute('role') || '',
      text: e.textContent?.trim().slice(0, 60) || '',
      visible: e.offsetWidth > 0 && e.offsetHeight > 0,
    }))
  })
  editors.forEach((e, i) => {
    console.log(`  [${i}] ce=${e.contenteditable} role=${e.role} label="${e.ariaLabel}" placeholder="${e.ariaPlaceholder}" text="${e.text}" visible=${e.visible}`)
  })

  console.log('\n✅ Done. Browser stays open for 30 seconds so you can inspect.')
  console.log('   Look at debug_group.png to see what Facebook shows.')
  await sleep(30000)
  await browser.close()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
debug().catch(console.error)
