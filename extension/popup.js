async function init() {
  const data = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey', 'activeCampaignId'])
  const ready = data.supabaseUrl && data.supabaseKey && data.activeCampaignId

  if (!ready) {
    document.getElementById('view-setup').style.display = 'block'
    if (data.supabaseUrl)      document.getElementById('inp-url').value = data.supabaseUrl
    if (data.supabaseKey)      document.getElementById('inp-key').value = data.supabaseKey
    if (data.activeCampaignId) document.getElementById('inp-cid').value = data.activeCampaignId
    return
  }

  document.getElementById('view-main').style.display = 'block'
  loadStats()
}

async function loadStats() {
  const data = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey', 'activeCampaignId', 'todayCount'])
  if (!data.supabaseUrl || !data.activeCampaignId) return

  try {
    // Fetch queue stats directly from Supabase REST — bypass background worker
    const url = `${data.supabaseUrl}/rest/v1/post_queue?campaign_id=eq.${data.activeCampaignId}&select=status`
    const res = await fetch(url, {
      headers: {
        'apikey': data.supabaseKey,
        'Authorization': 'Bearer ' + data.supabaseKey
      }
    })
    const items = await res.json()

    const total   = items.length
    const posted  = items.filter(i => i.status === 'posted').length
    const pending = items.filter(i => i.status === 'pending').length
    const failed  = items.filter(i => i.status === 'failed').length
    const skipped = items.filter(i => i.status === 'skipped').length
    const pct     = total ? Math.round((posted / total) * 100) : 0

    document.getElementById('m-fill').style.width   = pct + '%'
    document.getElementById('m-prog').textContent   = posted + ' of ' + total + ' posted (' + pct + '%)'
    document.getElementById('m-posted').textContent  = posted
    document.getElementById('m-pending').textContent = pending
    document.getElementById('m-failed').textContent  = failed
    document.getElementById('m-today').textContent   = data.todayCount || 0

    // Fetch campaign status
    const campRes = await fetch(
      `${data.supabaseUrl}/rest/v1/campaigns?id=eq.${data.activeCampaignId}&select=status,posting_start_hour,posting_end_hour,posts_per_day_limit`,
      { headers: { 'apikey': data.supabaseKey, 'Authorization': 'Bearer ' + data.supabaseKey } }
    )
    const camps = await campRes.json()
    const camp  = camps?.[0]

    const pill   = document.getElementById('m-pill')
    const reason = document.getElementById('m-reason')

    if (!camp) {
      pill.textContent = '⚠ Campaign not found'
      pill.className   = 'pill inactive'
      reason.textContent = 'Check your Campaign ID'
      return
    }

    const hour = new Date().getHours()
    const outsideWindow = hour < camp.posting_start_hour || hour >= camp.posting_end_hour

    if (camp.status !== 'active') {
      pill.textContent   = '⏸ Campaign is ' + camp.status
      pill.className     = 'pill paused'
      reason.textContent = 'Change status to "active" in Supabase'
    } else if (outsideWindow) {
      pill.textContent   = '⏸ Outside posting window'
      pill.className     = 'pill paused'
      reason.textContent = 'Posts between ' + camp.posting_start_hour + ':00 – ' + camp.posting_end_hour + ':00'
    } else if (total === 0) {
      pill.textContent   = '⚠ Queue is empty'
      pill.className     = 'pill inactive'
      reason.textContent = 'No pending posts found in post_queue'
    } else if (pending === 0) {
      pill.textContent   = '✓ Campaign complete'
      pill.className     = 'pill active'
      reason.textContent = posted + ' posted · ' + skipped + ' skipped · ' + failed + ' failed'
    } else {
      pill.textContent   = '● Active — ' + pending + ' posts queued'
      pill.className     = 'pill active'
      reason.textContent = 'Next post opens automatically within 60s'
    }

  } catch(e) {
    document.getElementById('m-pill').textContent = '⚠ Could not load stats'
    document.getElementById('m-pill').className   = 'pill inactive'
    document.getElementById('m-reason').textContent = e.message
  }
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const url = document.getElementById('inp-url').value.trim()
  const key = document.getElementById('inp-key').value.trim()
  const cid = document.getElementById('inp-cid').value.trim()
  if (!url || !key || !cid) { alert('All 3 fields are required'); return }
  await chrome.storage.local.set({ supabaseUrl: url, supabaseKey: key, activeCampaignId: cid })
  location.reload()
})

document.getElementById('btn-switch').addEventListener('click', async () => {
  const cid = document.getElementById('inp-new-cid').value.trim()
  if (!cid) return
  await chrome.storage.local.set({ activeCampaignId: cid, todayCount: 0, sessionCount: 0 })
  document.getElementById('inp-new-cid').value = ''
  loadStats()
})

document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('Clear all saved config and start over?')) return
  await chrome.storage.local.clear()
  location.reload()
})

init()
setInterval(loadStats, 5000)
