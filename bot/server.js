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
  'http://147.93.98.94:3001/browser/vnc.html?autoconnect=true&reconnect=true&resize=scale&path=browser/websockify'

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

function pushLog(botId, line) {
  if (!procs[botId]) procs[botId] = { proc: null, type: null, logs: [], campaignId: null }

  // Strip leading \r written by the countdown timer
  const cleanLine = line.startsWith('\r') ? line.slice(1) : line

  // Countdown lines are sent as a separate event type so the dashboard
  // renders them as a single updating line instead of appending endlessly
  if (cleanLine.startsWith('⏳ Time left before')) {
    ;(logSubs[botId] || []).forEach(res => {
      try { res.write(`data: ${JSON.stringify({ countdown: cleanLine })}\n\n`) } catch {}
    })
    return
  }

  procs[botId].logs = [...(procs[botId].logs || []).slice(-299), cleanLine]
  ;(logSubs[botId] || []).forEach(res => {
    try { res.write(`data: ${JSON.stringify({ line: cleanLine })}\n\n`) } catch {}
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
    req.on('timeout', () => req.destroy(new Error('timeout')))
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

function viewerUrlForSession(sessionId = '') {
  if (!sessionId) return REMOTE_VIEWER_URL

  try {
    const url = new URL(REMOTE_VIEWER_URL)
    url.searchParams.set('session', sessionId)
    return url.toString()
  } catch {
    const joiner = REMOTE_VIEWER_URL.includes('?') ? '&' : '?'
    return `${REMOTE_VIEWER_URL}${joiner}session=${encodeURIComponent(sessionId)}`
  }
}

async function startRemoteDesktop({ forceRestart = false } = {}) {
  const alreadyHealthy = !forceRestart && await isRemoteDesktopHealthy()
  if (alreadyHealthy) {
    return { ok: true, viewer_url: REMOTE_VIEWER_URL, reused: true }
  }

  if (forceRestart) await stopRemoteDesktop()

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

async function getCampaignSummary(campaignId) {
  const { data: campaign } = await db(sb =>
    sb.from('campaigns')
      .select('id, notes, total_posts, posts_per_day_limit, posting_start_hour, posting_end_hour, jitter_enabled, status')
      .eq('id', campaignId)
      .single()
  )

  const { count: pendingCount } = await db(sb =>
    sb.from('post_queue')
      .select('id', { head: true, count: 'exact' })
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
  )

  const { count: processingCount } = await db(sb =>
    sb.from('post_queue')
      .select('id', { head: true, count: 'exact' })
      .eq('campaign_id', campaignId)
      .eq('status', 'processing')
  )

  const { count: postedCount } = await db(sb =>
    sb.from('post_queue')
      .select('id', { head: true, count: 'exact' })
      .eq('campaign_id', campaignId)
      .eq('status', 'posted')
  )

  return {
    campaign,
    pendingCount: pendingCount || 0,
    processingCount: processingCount || 0,
    postedCount: postedCount || 0,
  }
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
  version: '5.0',
  supabase: supabase ? '✅ connected' : '❌ not configured',
  env_check: { url: !!SUPA_URL, key: !!SUPA_KEY },
  remote_viewer_url: REMOTE_VIEWER_URL,
}))

app.get('/health', (_req, res) => res.json({ ok: true, supabase: !!supabase }))

app.get('/remote-session/health', async (_req, res) => {
  const healthy = await isRemoteDesktopHealthy()
  res.json({ ok: true, healthy, viewer_url: REMOTE_VIEWER_URL })
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

    const remote = await startRemoteDesktop({ forceRestart: true })
    const viewerUrl = viewerUrlForSession(`${id}-${Date.now()}`)

    const env = {
      ...process.env,
      BOT_ACCOUNT_ID: id,
      SESSION_FILE: sp,
      DISPLAY: ':99',
    }

    pushLog(id, `🔐 Opening remote login session for ${bot.name} (${bot.fb_email})`)
    pushLog(id, `🖥️ Remote viewer: ${viewerUrl}`)
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

    res.json({ ok: true, viewer_url: viewerUrl, reused: !!remote.reused })
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

    const snapshot = await getCampaignSummary(campaignId)
    if (snapshot.campaign) {
      pushLog(
        id,
        `📈 Campaign snapshot — pending: ${snapshot.pendingCount}, processing: ${snapshot.processingCount}, posted: ${snapshot.postedCount}, daily cap: ${snapshot.campaign.posts_per_day_limit}`
      )
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
