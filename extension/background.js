// background.js — MV3 Service Worker, no ES imports

let config      = null
let processing  = false
let activeTabId = null

// ── Supabase REST ─────────────────────────────────────────
async function sbFetch(path, opts = {}) {
  const { method = 'GET', body, params } = opts
  let url = config.supabaseUrl + '/rest/v1/' + path
  if (params) url += '?' + new URLSearchParams(params).toString()
  const headers = {
    'apikey':        config.supabaseKey,
    'Authorization': 'Bearer ' + config.supabaseKey,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation'
  }
  const res  = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
const sbGet    = (t, p)     => sbFetch(t, { params: p })
const sbUpdate = (t, id, b) => sbFetch(t + '?id=eq.' + id, { method: 'PATCH', body: b })

// ── Lifecycle ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('poll', { periodInMinutes: 1 })
})
chrome.runtime.onStartup.addListener(async () => {
  await loadConfig()
  poll()
})
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'poll') poll()
})

async function loadConfig() {
  config = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey', 'activeCampaignId'])
  return config
}

// ── Poll ──────────────────────────────────────────────────
async function poll() {
  if (processing) return
  if (!config?.supabaseUrl) { await loadConfig(); if (!config?.supabaseUrl) return }

  const session = await getSessionState()
  if (!session.canPost) return

  const item = await getNextQueueItem()
  if (!item) return

  processing = true
  await chrome.storage.local.set({ pendingItem: item })
  const tab = await chrome.tabs.create({ url: item.groups.fb_url, active: true })
  activeTabId = tab.id
}

// ── Session State ─────────────────────────────────────────
async function getSessionState() {
  const now  = new Date()
  const hour = now.getHours()
  const stored = await chrome.storage.local.get([
    'todayCount','todayDate','sessionCount','sessionBreakUntil','activeCampaignId'
  ])
  const { todayCount=0, todayDate='', sessionCount=0, sessionBreakUntil=0, activeCampaignId } = stored

  if (!activeCampaignId) return { canPost: false, reason: 'No active campaign set' }

  if (sessionBreakUntil && Date.now() < sessionBreakUntil) {
    const mins = Math.round((sessionBreakUntil - Date.now()) / 60000)
    return { canPost: false, reason: 'Session break — resumes in ' + mins + ' min' }
  }

  try {
    const rows = await sbGet('campaigns', {
      id: 'eq.' + activeCampaignId,
      select: 'status,posts_per_day_limit,posting_start_hour,posting_end_hour'
    })
    const c = rows?.[0]
    if (!c)                    return { canPost: false, reason: 'Campaign not found' }
    if (c.status !== 'active') return { canPost: false, reason: 'Campaign is not active' }
    if (hour < c.posting_start_hour || hour >= c.posting_end_hour)
      return { canPost: false, reason: 'Outside posting window' }
    const today = now.toDateString()
    const count = todayDate === today ? todayCount : 0
    if (count >= c.posts_per_day_limit)
      return { canPost: false, reason: 'Daily cap reached (' + c.posts_per_day_limit + '/day)' }
    return { canPost: true, todayCount: count, sessionCount }
  } catch(e) {
    return { canPost: false, reason: 'Supabase error: ' + e.message }
  }
}

// ── Next Queue Item ───────────────────────────────────────
// Fetches the next PENDING item — ignores scheduled_at so nothing gets stuck
async function getNextQueueItem() {
  const { activeCampaignId } = await chrome.storage.local.get('activeCampaignId')
  if (!activeCampaignId) return null
  try {
    const rows = await sbGet('post_queue', {
      campaign_id: 'eq.' + activeCampaignId,
      status:      'eq.pending',
      select:      'id,campaign_id,property_id,group_id,scheduled_at,duplicate_warned,properties(id,title,description,rent,locality,phone,whatsapp_link,photos),groups(id,name,fb_url)',
      order:       'scheduled_at.asc',
      limit:       1
    })
    return rows?.[0] || null
  } catch { return null }
}

// ── Messages ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_PENDING_ITEM') {
    chrome.storage.local.get('pendingItem').then(({ pendingItem }) => {
      sendResponse({ item: pendingItem || null })
    })
    return true
  }
  if (msg.type === 'POST_RESULT') {
    handlePostResult(msg.result, msg.itemId).then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg.type === 'GET_CAMPAIGN_STATS') {
    getCampaignStats().then(stats => sendResponse(stats))
    return true
  }
})

async function handlePostResult({ status, error }, itemId) {
  const now = new Date()
  try {
    await sbUpdate('post_queue', itemId, {
      status,
      posted_at: status === 'posted' ? now.toISOString() : null,
      error_log: error || null
    })
  } catch(e) { console.error('Queue update failed', e) }

  const { todayCount=0, todayDate='', sessionCount=0 } =
    await chrome.storage.local.get(['todayCount','todayDate','sessionCount'])
  const today    = now.toDateString()
  const newToday = todayDate === today ? todayCount + 1 : 1
  const newSess  = sessionCount + 1
  const updates  = { todayCount: newToday, todayDate: today, sessionCount: newSess, pendingItem: null }

  if (newSess >= 8) {
    const ms = (120 + Math.random() * 60) * 60 * 1000
    updates.sessionBreakUntil = Date.now() + ms
    updates.sessionCount = 0
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: 'Session break started',
      message: 'Resuming in ~' + Math.round(ms/60000) + ' min to stay safe.'
    })
  }

  await chrome.storage.local.set(updates)
  processing = false
  if (activeTabId) {
    setTimeout(() => { chrome.tabs.remove(activeTabId).catch(()=>{}); activeTabId = null }, 6000)
  }
}

async function getCampaignStats() {
  const { activeCampaignId, todayCount=0 } =
    await chrome.storage.local.get(['activeCampaignId','todayCount'])
  if (!activeCampaignId) return { total:0, posted:0, pending:0, skipped:0, failed:0 }
  try {
    const rows    = await sbGet('post_queue', { campaign_id: 'eq.' + activeCampaignId, select: 'status' })
    const items   = rows || []
    const posted  = items.filter(i => i.status === 'posted').length
    const pending = items.filter(i => i.status === 'pending').length
    const skipped = items.filter(i => i.status === 'skipped').length
    const failed  = items.filter(i => i.status === 'failed').length
    const session = await getSessionState()
    return { total: items.length, posted, pending, skipped, failed, todayCount, canPost: session.canPost, reason: session.reason }
  } catch { return { total:0, posted:0, pending:0, skipped:0, failed:0 } }
}
