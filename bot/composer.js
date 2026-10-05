// composer.js — put post text into Facebook's composer exactly once, keeping line breaks.
// Text is typed line by line with real Enter presses (Facebook's editor handles these
// natively), the box is cleared before every attempt, and the result is read back and
// compared so a duplicated or mangled body is never posted.

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Lines as Facebook shows them: invisible chars removed, spaces collapsed, blanks dropped
export function composerLines(text) {
  return String(text || '')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

export function composerTextMatches(expected, actual) {
  const a = composerLines(expected)
  const b = composerLines(actual)
  return a.length === b.length && a.every((line, i) => line === b[i])
}

export async function readComposerText(locator) {
  return await locator.evaluate(el => el.innerText || el.textContent || '')
}

export async function clearComposer(page, locator) {
  await locator.click()
  await sleep(200)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await sleep(300)
  if (composerLines(await readComposerText(locator)).length) {
    // Fallback for editors that ignore select-all
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await sleep(300)
  }
}

export async function typeLines(page, text) {
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i])
    if (i < lines.length - 1) await page.keyboard.press('Enter')
    await sleep(40 + Math.floor(Math.random() * 60))
  }
}

// Clear → type → verify, up to `attempts` times. Returns { ok, actual }.
export async function fillComposer(page, locator, text, { attempts = 2 } = {}) {
  let actual = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await clearComposer(page, locator)
    await typeLines(page, text)
    await sleep(600)
    actual = await readComposerText(locator)
    if (composerTextMatches(text, actual)) return { ok: true, actual }
    console.log(`   ⚠️ Composer text mismatch (attempt ${attempt}/${attempts}) — expected ${composerLines(text).length} lines, got ${composerLines(actual).length}`)
  }
  return { ok: false, actual }
}
