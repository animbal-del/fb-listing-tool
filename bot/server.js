// server.js — Local API bridge between Dashboard and bot processes
// Run inside bot container

import express from 'express'
import cors from 'cors'
import { spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import http from 'http'
import httpProxy from 'http-proxy'
import 'dotenv/config'

const __dir = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

const REMOTE_VIEWER_URL =
  process.env.REMOTE_VIEWER_URL ||
  'http://147.93.98.94:3001/browser/vnc.html?autoconnect=true&resize=remote&path=browser/websockify'

app.use(cors({ origin: '*' }))
app.use(express.json())

const SUPA_URL = process.env.SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_KEY

if (!SUPA_URL || !SUPA_KEY) {
  console.error('\n❌ MISSING: SUPABASE_URL or SUPABASE_KEY not found in bot/.env')
  console.error('   Create bot/.env with:')
  console.error('   SUPABASE_URL=https://xxxx.supabase.co')
  console.error('   SUPABASE_KEY=your_anon_key\n')
}

let supabase = null
try {
  if (SUPA_URL && SUPA_KEY) supabase = createClient(SUPA_URL, SUPA_KEY)
} catch (e) {
  console.error('Supabase init error:', e.message)
}

async function db(fn) {
  if (!supabase) {
    return { data: null, error: { message: 'Supabase not configured — add SUPABASE_URL and SUPABASE_KEY to bot/.env' } }
  }
  try {
    return await fn(supabase)
  } catch (e) {
    return { data: null, error: { message: e.message } }
  }
}

const procs = {}
const logSubs = {}
const botQueues = {}


function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function buildTodaySlots(count, startHour, endHour, jitterEnabled = false) {
  if (count <= 0) return []
  const now = new Date()
  const start = new Date(now)
  start.setHours(Number(startHour || 9), 0, 0, 0)
  const end = new Date(now)
  end.setHours(Number(endHour || 20), 0, 0, 0)
  if (end <= start) end.setHours(start.getHours() + 8, 0, 0, 0)
  const span = end.getTime() - start.getTime()
  const gap = Math.max(1, Math.floor(span / Math.max(count, 1)))
  const slots = []
  for (let i = 0; i < count; i++) {
    let t = new Date(start.getTime() + i * gap)
    if (jitterEnabled) {
      const jitter = Math.floor((Math.random() - 0.5) * Math.min(gap * 0.35, 20 * 60 * 1000))
      t = new Date(t.getTime() + jitter)
    }
    if (i === 0 && t < now) t = new Date(now)
    slots.push(t.toISOString())
  }
  return slots
}

async function allocateCampaignForToday(campaignId) {
  const { data: campaign, error: campaignError } = await db(sb => sb.from('campaigns').select('*').eq('id', campaignId).single())
  if (campaignError || !campaign) throw new Error(campaignError?.message || 'Campaign not found')

  const activeBotIds = Object.entries(procs)
    .filter(([, meta]) => meta?.type === 'bot' && meta?.campaignId === campaignId)
    .map(([botId]) => botId)

  if (activeBotIds.length === 0) {
    return { allocated: 0, activeBotIds: [], shares: {} }
  }

  const { data: bots, error: botsError } = await db(sb => sb.from('bot_accounts').select('*').in('id', activeBotIds))
  if (botsError) throw new Error(botsError.message)

  const today = startOfToday()
  const botRows = (bots || []).map(bot => {
    const used = bot.posts_today_date === today ? Number(bot.posts_today || 0) : 0
    const remaining = Math.max(0, Number(bot.max_posts_per_day || 18) - used)
    return { ...bot, remaining }
  }).filter(bot => bot.remaining > 0)

  if (botRows.length === 0) return { allocated: 0, activeBotIds, shares: {} }

  const totalBotRemaining = botRows.reduce((sum, bot) => sum + bot.remaining, 0)

  const { count: remainingCount, error: remainingError } = await db(sb => sb.from('post_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).in('status', ['pending', 'failed']))
  if (remainingError) throw new Error(remainingError.message)

  const alreadyAssignedTodayQuery = await db(sb => sb.from('post_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).not('assigned_bot_id', 'is', null).gte('scheduled_at', `${today}T00:00:00`).lt('scheduled_at', `${today}T23:59:59.999`))
  const alreadyAssignedToday = Number(alreadyAssignedTodayQuery.count || 0)
  const campaignDailyLimit = Number(campaign.posts_per_day_limit || 18)
  const campaignRemainingForToday = Math.max(0, campaignDailyLimit - alreadyAssignedToday)
  const todayTarget = Math.min(Number(remainingCount || 0), campaignRemainingForToday, totalBotRemaining)

  if (todayTarget <= 0) return { allocated: 0, activeBotIds, shares: {} }

  const shares = {}
  let left = todayTarget
  let botsLeft = botRows.length
  for (const bot of botRows) {
    const fair = Math.ceil(left / botsLeft)
    const share = Math.max(0, Math.min(bot.remaining, fair))
    shares[bot.id] = share
    left -= share
    botsLeft -= 1
  }
  if (left > 0) {
    for (const bot of botRows) {
      const extraCap = bot.remaining - (shares[bot.id] || 0)
      const extra = Math.min(extraCap, left)
      shares[bot.id] += extra
      left -= extra
      if (left <= 0) break
    }
  }

  for (const bot of botRows) {
    const share = shares[bot.id] || 0
    if (share <= 0) continue
    const { data: items, error: itemsError } = await db(sb => sb.from('post_queue').select('id').eq('campaign_id', campaignId).eq('status', 'pending').is('assigned_bot_id', null).order('created_at', { ascending: true }).limit(share))
    if (itemsError) throw new Error(itemsError.message)
    const slots = buildTodaySlots(share, campaign.posting_start_hour, campaign.posting_end_hour, campaign.jitter_enabled)
    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i]
      const slot = slots[i] || new Date().toISOString()
      const { error: updateError } = await db(sb => sb.from('post_queue').update({ assigned_bot_id: bot.id, scheduled_at: slot, claimed_at: null }).eq('id', item.id))
      if (updateError) throw new Error(updateError.message)
    }
  }

  return { allocated: todayTarget, activeBotIds, shares }
}

function pushLog(botId, line) {
  if (!procs[botId]) procs[botId] = { proc: null, type: null, logs: [], campaignId: null }
  procs[botId].logs = [...(procs[botId].logs || []).slice(-299), line]
  ;(logSubs[botId] || []).forEach(res => {
    try { res.write(`data: ${JSON.stringify({ line })}\n\n`) } catch {}
  })
}

function isAlive(id) {
  const p = procs[id]?.proc
  return !!(p && p.exitCode === null && !p.killed)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function runDetached(cmd, args = []) {
  const proc = spawn(cmd, args, {
    cwd: __dir,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  proc.unref()
}

function httpGet(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk.toString() })
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }))
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
  })
}

async function isRemoteDesktopHealthy() {
  try {
    const res = await httpGet('http://127.0.0.1:6080/vnc.html', 2000)
    return res.statusCode === 200 && String(res.body || '').includes('noVNC')
  } catch {
    return false
  }
}

async function waitForRemoteDesktopReady(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isRemoteDesktopHealthy()) return true
    await sleep(500)
  }
  return false
}

async function startRemoteDesktop() {
  const alreadyHealthy = await isRemoteDesktopHealthy()
  if (alreadyHealthy) {
    return { ok: true, viewer_url: REMOTE_VIEWER_URL, reused: true }
  }

  runDetached('bash', [join(__dir, 'start-remote-login-session.sh')])

  const ready = await waitForRemoteDesktopReady(15000)
  if (!ready) {
    throw new Error('Remote desktop failed to become ready on port 6080')
  }

  return { ok: true, viewer_url: REMOTE_VIEWER_URL, reused: false }
}

async function stopRemoteDesktop() {
  try { spawn('pkill', ['-f', 'Xvfb :99']) } catch {}
  try { spawn('pkill', ['-f', 'x11vnc.*5901']) } catch {}
  try { spawn('pkill', ['-f', 'websockify.*6080']) } catch {}
  try { spawn('pkill', ['-f', 'novnc_proxy.*6080']) } catch {}
  try { spawn('pkill', ['-f', 'fluxbox']) } catch {}
  return { ok: true }
}

// noVNC HTTP + WebSocket proxy to local 6080
const browserProxy = httpProxy.createProxyServer({
  target: 'http://127.0.0.1:6080',
  ws: true,
  changeOrigin: true,
  xfwd: true,
})

browserProxy.on('error', (err, req, res) => {
  console.error('Browser proxy error:', err.message)

  if (res && !res.headersSent) {
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: `Browser proxy failed: ${err.message}` }))
    return
  }

  try { res?.end?.() } catch {}
})

app.use('/browser', (req, res) => {
  req.url = req.originalUrl.replace(/^\/browser/, '') || '/'
  browserProxy.web(req, res)
})

app.get('/', (_req, res) => res.json({
  status: '✅ FB Listing Bot Server running',
  version: '4.3',
  supabase: supabase ? '✅ connected' : '❌ not configured',
  env_check: { url: !!SUPA_URL, key: !!SUPA_KEY },
  remote_viewer_url: REMOTE_VIEWER_URL,
}))

app.get('/health', (_req, res) => res.json({ ok: true, supabase: !!supabase }))

app.get('/remote-session/health', async (_req, res) => {
  const healthy = await isRemoteDesktopHealthy()
  res.json({
    ok: true,
    healthy,
    viewer_url: REMOTE_VIEWER_URL,
  })
})

app.post('/remote-session/start', async (_req, res) => {
  try {
    const result = await startRemoteDesktop()
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/remote-session/stop', async (_req, res) => {
  try {
    const result = await stopRemoteDesktop()
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/bots', async (_req, res) => {
  try {
    const { data, error } = await db(sb => sb.from('bot_accounts').select('*').order('created_at'))

    if (error) {
      console.error('/bots DB error:', error.message)
      return res.json({ bots: [], error: error.message })
    }

    const bots = (data || []).map(bot => {
      const sp = join(__dir, bot.session_file || `fb_session_${bot.id.slice(0, 8)}.json`)
      return {
        ...bot,
        isRunning: isAlive(bot.id) && procs[bot.id]?.type === 'bot',
        isLoggingIn: isAlive(bot.id) && procs[bot.id]?.type === 'login',
        hasSession: existsSync(sp),
        campaignId: procs[bot.id]?.campaignId || null,
      }
    })

    res.json(bots)
  } catch (e) {
    console.error('/bots unexpected error:', e.message)
    res.json([])
  }
})

async function handleLoginRemote(req, res) {
  const { id } = req.params

  try {
    if (isAlive(id)) {
      try { procs[id].proc.kill('SIGTERM') } catch {}
      await sleep(500)
    }

    const { data: bot, error } = await db(sb => sb.from('bot_accounts').select('*').eq('id', id).single())
    if (error || !bot) return res.status(404).json({ error: 'Bot not found: ' + (error?.message || '') })
    if (!bot.fb_email || !bot.fb_password) return res.status(400).json({ error: 'Bot has no credentials' })

    await db(sb => sb.from('bot_accounts').update({ status: 'logging_in' }).eq('id', id))

    const sp = join(__dir, bot.session_file || `fb_session_${bot.id.slice(0, 8)}.json`)

    const remote = await startRemoteDesktop()

    const env = {
      ...process.env,
      BOT_ACCOUNT_ID: id,
      SESSION_FILE: sp,
      DISPLAY: ':99',
    }

    pushLog(id, `🔐 Opening remote login session for ${bot.name} (${bot.fb_email})`)
    pushLog(id, `🖥️ Remote viewer: ${REMOTE_VIEWER_URL}`)
    pushLog(id, remote.reused ? '♻️ Reusing shared remote desktop' : '🆕 Started shared remote desktop')

    const proc = spawn('node', [join(__dir, 'login.js')], { env, cwd: __dir })
    procs[id] = { ...(procs[id] || {}), proc, type: 'login', logs: procs[id]?.logs || [] }

    proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)))
    proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, `⚠️ ${l}`)))

    proc.on('close', async code => {
      const ok = code === 0
      pushLog(id, ok ? '✅ Login complete — session saved' : `❌ Login failed (code ${code})`)
      await db(sb => sb.from('bot_accounts').update({
        status: ok ? 'idle' : 'error',
        ...(ok ? { last_active: new Date().toISOString() } : {}),
      }).eq('id', id))
      if (procs[id]) procs[id].proc = null
    })

    res.json({ ok: true, viewer_url: REMOTE_VIEWER_URL, reused: !!remote.reused })
  } catch (e) {
    console.error('/login error:', e.message)
    res.status(500).json({ error: e.message })
  }
}

app.post('/bots/:id/login', handleLoginRemote)
app.post('/bots/:id/login-remote', handleLoginRemote)

app.post('/bots/:id/start', async (req, res) => {
  const { id } = req.params
  const { campaignId } = req.body
  if (!campaignId) return res.status(400).json({ error: 'campaignId required' })

  try {
    if (isAlive(id)) {
      try { procs[id].proc.kill('SIGTERM') } catch {}
      await sleep(500)
    }

    const { data: bot, error } = await db(sb => sb.from('bot_accounts').select('*').eq('id', id).single())
    if (error || !bot) return res.status(404).json({ error: 'Bot not found' })

    const sp = join(__dir, bot.session_file || `fb_session_${bot.id.slice(0, 8)}.json`)
    if (!existsSync(sp)) return res.status(400).json({ error: 'No session file — please login first' })

    await db(sb => sb.from('bot_accounts').update({ status: 'running' }).eq('id', id))
    pushLog(id, `🚀 Starting: ${bot.name}`)
    pushLog(id, `📋 Campaign: ${campaignId}`)

    procs[id] = { ...(procs[id] || {}), proc: null, type: 'bot', campaignId }
    const allocation = await allocateCampaignForToday(campaignId)
    pushLog(id, `📊 Daily allocation prepared: ${allocation.allocated} post(s) across ${allocation.activeBotIds.length} active bot(s)`)
    if (allocation.shares?.[id] != null) {
      pushLog(id, `🤖 This bot assigned ${allocation.shares[id]} post(s) for today on this campaign`)
    }

    const spawnBot = (cid) => {
      const env = { ...process.env, BOT_ACCOUNT_ID: id, SESSION_FILE: sp, CAMPAIGN_ID: cid }
      const p = spawn('node', [join(__dir, 'bot.js')], { env, cwd: __dir })
      procs[id] = { ...(procs[id] || {}), proc: p, type: 'bot', campaignId: cid }

      p.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)))
      p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, `⚠️ ${l}`)))

      p.on('close', async code => {
        pushLog(id, code === 0 ? '🎉 Campaign run ended' : `⚠️ Bot stopped (code ${code})`)

        if (procs[id]) procs[id].proc = null

        if (code !== 0) {
          await db(sb => sb.from('bot_accounts').update({ status: 'idle' }).eq('id', id))
          return
        }

        const queue = botQueues[id] || []
        const idx = queue.indexOf(cid)

        let next = null
        if (idx >= 0 && idx < queue.length - 1) {
          next = queue[idx + 1]
        } else if (idx === -1 && queue.length > 0) {
          next = queue[0]
          botQueues[id] = queue.slice(1)
        } else if (idx >= 0) {
          botQueues[id] = []
        }

        if (next) {
          pushLog(id, '⏭️ Queue: starting next campaign in 5s...')
          pushLog(id, `📋 Campaign: ${next}`)
          await sleep(5000)
          spawnBot(next)
        } else {
          pushLog(id, '✅ Queue complete — no more queued campaigns')
          await db(sb => sb.from('bot_accounts').update({ status: 'idle' }).eq('id', id))
        }
      })
    }

    spawnBot(campaignId)
    res.json({ ok: true })
  } catch (e) {
    console.error('/start error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/bots/:id/stop', async (req, res) => {
  const { id } = req.params
  try {
    if (isAlive(id)) {
      try { procs[id].proc.kill('SIGTERM') } catch {}
      pushLog(id, '🛑 Stopped by user')
    }
    await db(sb => sb.from('bot_accounts').update({ status: 'idle' }).eq('id', id))
    if (procs[id]) procs[id].proc = null
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/bots/:id/logs', (req, res) => {
  const { id } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  ;(procs[id]?.logs || []).forEach(line => res.write(`data: ${JSON.stringify({ line })}\n\n`))
  if (!logSubs[id]) logSubs[id] = []
  logSubs[id].push(res)
  req.on('close', () => {
    logSubs[id] = (logSubs[id] || []).filter(r => r !== res)
  })
})

app.get('/bots/:id/queue', (req, res) => res.json({ queue: botQueues[req.params.id] || [] }))

app.delete('/bots/:id/queue', (req, res) => {
  botQueues[req.params.id] = []
  res.json({ ok: true })
})

app.post('/bots/:id/queue', (req, res) => {
  const { id } = req.params
  const { campaignIds } = req.body
  if (!Array.isArray(campaignIds)) return res.status(400).json({ error: 'campaignIds must be array' })
  botQueues[id] = campaignIds
  pushLog(id, `📋 Queue: ${campaignIds.length} campaign(s)`)
  res.json({ ok: true, queue: campaignIds })
})

const server = app.listen(PORT, () => {
  console.log('\n🟢 FB Listing Bot Server started')
  console.log(`   URL:      http://localhost:${PORT}`)
  console.log(`   Health:   http://localhost:${PORT}/health`)
  console.log(`   Remote viewer: ${REMOTE_VIEWER_URL}`)
  console.log(`   Supabase: ${supabase ? '✅ connected' : '❌ NOT configured'}`)
  if (!supabase) {
    console.log('\n   ⚠️  Create bot/.env with:')
    console.log('   SUPABASE_URL=https://xxxx.supabase.co')
    console.log('   SUPABASE_KEY=your_anon_key_here')
    console.log('   Then restart: node server.js\n')
  } else {
    console.log('\n   Keep this terminal open.\n')
  }
})

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/browser/')) {
    socket.destroy()
    return
  }

  req.url = req.url.replace(/^\/browser/, '') || '/'
  browserProxy.ws(req, socket, head)
})