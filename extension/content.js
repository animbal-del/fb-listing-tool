// content.js — injected into facebook.com/groups/* pages

;(async () => {
  if (document.getElementById('lp-overlay')) return

  await sleep(3000)

  const { item } = await chrome.runtime.sendMessage({ type: 'GET_PENDING_ITEM' })
  if (!item) return

  injectOverlay(item)
  await navigateToDiscussionAndOpenComposer(item)
})()

// ── Navigate to Discussion tab and open composer ──────────
async function navigateToDiscussionAndOpenComposer(item) {
  // Step 1: Make sure we're on the Discussion tab (not Watch, Events, etc.)
  await goToDiscussionTab()
  await sleep(2000)

  // Step 2: Try to click the "Write something..." composer
  const filled = await tryFillComposer(item)
  if (filled) {
    updateStatus('✅ Text filled — click Post Now when ready')
  } else {
    await copyToClipboard(buildPostText(item))
    updateStatus('⚠️ Could not auto-fill — text copied to clipboard, paste with Cmd+V / Ctrl+V')
  }
}

async function goToDiscussionTab() {
  // Look for the Discussion tab link in the group nav
  const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'))
  for (const link of links) {
    const text = link.textContent.trim().toLowerCase()
    if (text === 'discussion' || text === 'posts') {
      const currentUrl = window.location.href
      const href       = link.href
      // Only navigate if not already there
      if (!currentUrl.includes(href.split('/groups/')[1]?.split('/')[0])) {
        link.click()
        await sleep(2500)
      }
      return
    }
  }
  // If no Discussion tab found, we're probably already on it — continue
}

async function tryFillComposer(item) {
  const text = buildPostText(item)

  // Selectors for the "Write something..." trigger button
  const triggerSelectors = [
    '[aria-label="Write something..."]',
    '[aria-placeholder="Write something..."]',
    'div[role="button"]:not([aria-label])',
  ]

  // Try clicking the composer trigger up to 8 times
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const sel of triggerSelectors) {
      const candidates = document.querySelectorAll(sel)
      for (const el of candidates) {
        const txt = el.textContent?.trim().toLowerCase()
        if (
          el.getAttribute('aria-label')?.toLowerCase().includes('write') ||
          el.getAttribute('aria-placeholder')?.toLowerCase().includes('write') ||
          txt.includes("write something") ||
          txt.includes("what's on your mind")
        ) {
          el.click()
          await sleep(1800)
          const pasted = await pasteIntoActiveComposer(text)
          if (pasted) return true
        }
      }
    }
    await sleep(1500)
  }
  return false
}

async function pasteIntoActiveComposer(text) {
  // Find the active contenteditable that appeared after clicking the composer
  const editors = document.querySelectorAll('[contenteditable="true"]')
  for (const editor of editors) {
    // Skip comment boxes — we want the main post composer
    const isCommentBox = editor.closest('[aria-label*="comment" i]') ||
                         editor.closest('[data-testid*="comment"]') ||
                         editor.getAttribute('aria-label')?.toLowerCase().includes('comment')
    if (isCommentBox) continue

    // Check it's visible
    const rect = editor.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue

    editor.focus()
    await sleep(300)
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    document.execCommand('insertText', false, text)

    // Verify text was inserted
    if (editor.textContent.length > 10) return true
  }
  return false
}

function buildPostText(item) {
  const p = item.properties
  let text = p.description || ''
  text = text.replace(/\{phone\}/g,         p.phone         || '')
  text = text.replace(/\{whatsapp_link\}/g, p.whatsapp_link || '')
  text = text.replace(/\{locality\}/g,      p.locality      || '')
  text = text.replace(/\{rent\}/g,          p.rent ? '₹' + p.rent.toLocaleString() : '')
  text = text.replace(/\{deposit\}/g,       p.deposit ? '₹' + p.deposit.toLocaleString() : '')
  return text
}

// ── Overlay UI ────────────────────────────────────────────
function injectOverlay(item) {
  const prop  = item.properties
  const group = item.groups

  const el = document.createElement('div')
  el.id = 'lp-overlay'
  el.innerHTML = `
    <style>
      #lp-overlay {
        position: fixed; bottom: 24px; right: 24px; z-index: 999999;
        width: 300px; background: #131D30; border: 1px solid #2C3A5A;
        border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
        font-family: system-ui, sans-serif; overflow: hidden;
      }
      #lp-overlay .lp-header {
        padding: 12px 14px; border-bottom: 1px solid #1E2B45;
        display: flex; align-items: center; gap: 8px;
      }
      #lp-overlay .lp-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #FF6B35; flex-shrink: 0;
        animation: lp-pulse 1.5s infinite;
      }
      @keyframes lp-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
      #lp-overlay .lp-title { font-size: 12px; font-weight: 600; color: #E1E5EC; flex: 1; }
      #lp-overlay .lp-close { background: none; border: none; color: #6B7A99; cursor: pointer; font-size: 16px; }
      #lp-overlay .lp-body { padding: 12px 14px; }
      #lp-overlay .lp-label { font-size: 10px; color: #6B7A99; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2px; }
      #lp-overlay .lp-value { font-size: 12px; color: #C3CAD9; margin-bottom: 8px; }
      #lp-overlay .lp-warn { background: rgba(234,179,8,.1); border: 1px solid rgba(234,179,8,.25); color: #fbbf24; font-size: 11px; padding: 6px 10px; border-radius: 8px; margin-bottom: 8px; }
      #lp-overlay .lp-actions { display: flex; gap: 8px; padding: 0 14px 12px; }
      #lp-overlay .lp-btn { flex: 1; padding: 9px; border-radius: 10px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; }
      #lp-overlay .lp-btn-post { background: #FF6B35; color: white; }
      #lp-overlay .lp-btn-skip { background: #1E2B45; color: #9FABBE; }
      #lp-overlay .lp-status { padding: 8px 14px; background: #0A1120; font-size: 11px; color: #9FABBE; text-align: center; border-top: 1px solid #1E2B45; }
    </style>
    <div class="lp-header">
      <div class="lp-dot"></div>
      <div class="lp-title">Listing Poster</div>
      <button class="lp-close" id="lp-close-btn">✕</button>
    </div>
    <div class="lp-body">
      <div class="lp-label">Posting to</div>
      <div class="lp-value">${esc(group.name)}</div>
      <div class="lp-label">Listing</div>
      <div class="lp-value">${esc(prop.title)}</div>
      ${prop.locality ? `<div class="lp-value" style="font-size:11px;color:#9FABBE">📍 ${esc(prop.locality)}${prop.rent ? ' · ₹' + prop.rent.toLocaleString() + '/mo' : ''}</div>` : ''}
      ${item.duplicate_warned ? `<div class="lp-warn">⚠️ Posted here recently — confirm before posting</div>` : ''}
    </div>
    <div class="lp-actions">
      <button class="lp-btn lp-btn-post" id="lp-post-btn">✓ Post Now</button>
      <button class="lp-btn lp-btn-skip" id="lp-skip-btn">Skip</button>
    </div>
    <div class="lp-status" id="lp-status-text">Opening Discussion tab…</div>
  `
  document.body.appendChild(el)

  document.getElementById('lp-post-btn').addEventListener('click', () => handlePost(item))
  document.getElementById('lp-skip-btn').addEventListener('click', () => handleSkip(item))
  document.getElementById('lp-close-btn').addEventListener('click', () => el.remove())
}

// ── Post / Skip ───────────────────────────────────────────
async function handlePost(item) {
  updateStatus('Clicking Post button…')
  setButtons(true)

  const posted = await clickFacebookPostButton()

  await chrome.runtime.sendMessage({
    type: 'POST_RESULT',
    itemId: item.id,
    result: {
      status: posted ? 'posted' : 'failed',
      error:  posted ? null : 'Could not find Facebook Post button — click it manually'
    }
  })
  updateStatus(posted ? '✅ Posted! Tab closes in 6s…' : '❌ Click the blue Post button manually, then click Post Now again')
  if (!posted) setButtons(false)
}

async function handleSkip(item) {
  await chrome.runtime.sendMessage({
    type: 'POST_RESULT',
    itemId: item.id,
    result: { status: 'skipped' }
  })
  updateStatus('Skipped. Closing tab…')
}

async function clickFacebookPostButton() {
  // Look specifically for the Post submit button inside the composer dialog
  const selectors = [
    'div[aria-label="Post"][role="button"]',
    'div[aria-label="post"][role="button"]',
    '[data-testid="react-composer-post-button"]',
    'div[role="dialog"] div[role="button"][tabindex="0"]:last-child',
  ]
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const sel of selectors) {
      const btns = document.querySelectorAll(sel)
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase()
        if (label.includes('post') && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click()
          await sleep(1500)
          return true
        }
      }
    }
    await sleep(1000)
  }
  return false
}

// ── Helpers ───────────────────────────────────────────────
function updateStatus(msg) {
  const el = document.getElementById('lp-status-text')
  if (el) el.textContent = msg
}
function setButtons(disabled) {
  ['lp-post-btn','lp-skip-btn'].forEach(id => {
    const b = document.getElementById(id)
    if (b) b.disabled = disabled
  })
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text) } catch {}
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
