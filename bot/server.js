// server.js — Local API bridge between Dashboard and bot processes
// Run inside bot container

import express from 'express'
import cors from 'cors'
import { spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'

const __dir = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001
const REMOTE_VIEWER_URL = '/bot-browser/vnc.html?autoconnect=true&resize=remote&path=websockify'

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

const procs = {}      // botId -> { proc, type, logs[], campaignId }
const logSubs = {}    // botId -> [res, ...]
const botQueues = {}  // botId -> [campaignId, ...]

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

async function startRemoteDesktop() {
  runDetached('bash', [join(__dir, 'start-remote-login-session.sh')])
  await sleep(3000)
  return { ok: true, viewer_url: REMOTE_VIEWER_URL }
}

async function stopRemoteDesktop() {
  try { spawn('pkill', ['-f', 'Xvfb :99']) } catch {}
  try { spawn('pkill', ['-f', 'x11vnc.*5901']) } catch {}
  try { spawn('pkill', ['-f', 'websockify.*6080']) } catch {}
  try { spawn('pkill', ['-f', 'novnc_proxy.*6080']) } catch {}
  try { spawn('pkill', ['-f', 'fluxbox']) } catch {}
  return { ok: true }
}

app.get('/', (_req, res) => res.json({
  status: '✅ FB Listing Bot Server running',
  version: '4.0',
  supabase: supabase ? '✅ connected' : '❌ not configured',
  env_check: { url: !!SUPA_URL, key: !!SUPA_KEY },
  remote_viewer_url: REMOTE_VIEWER_URL,
}))

app.get('/health', (_req, res) => res.json({ ok: true, supabase: !!supabase }))

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

    await startRemoteDesktop()

    const env = {
      ...process.env,
      BOT_ACCOUNT_ID: id,
      SESSION_FILE: sp,
      DISPLAY: ':99',
    }

    pushLog(id, `🔐 Opening remote login session for ${bot.name} (${bot.fb_email})`)
    pushLog(id, `🖥️ Remote viewer: ${REMOTE_VIEWER_URL}`)

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

    res.json({ ok: true, viewer_url: REMOTE_VIEWER_URL })
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

    const spawnBot = (cid) => {
      const env = { ...process.env, BOT_ACCOUNT_ID: id, SESSION_FILE: sp, CAMPAIGN_ID: cid }
      const p = spawn('node', [join(__dir, 'bot.js')], { env, cwd: __dir })
      procs[id] = { ...(procs[id] || {}), proc: p, type: 'bot', campaignId: cid }

      p.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)))
      p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, `⚠️ ${l}`)))

      p.on('close', async code => {
        pushLog(id, code === 0 ? '🎉 Campaign complete!' : `⚠️ Bot stopped (code ${code})`)

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
          pushLog(id, `⏭️ Queue: starting next campaign in 5s...`)
          pushLog(id, `📋 Campaign: ${next}`)
          await sleep(5000)
          spawnBot(next)
        } else {
          pushLog(id, '✅ Queue complete — all campaigns done!')
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

app.listen(PORT, () => {
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