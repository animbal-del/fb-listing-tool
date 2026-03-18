import { useState, useEffect, useCallback, useRef } from 'react'
import { useCampaigns } from '../hooks/useCampaigns'
import { supabase } from '../lib/supabase'
import StatusBadge from '../components/StatusBadge'
import Modal from '../components/Modal'
import {
  Pause, Play, Download, RefreshCw, ChevronDown, ChevronUp,
  Copy, Check, Bot, Plus, Trash2, Eye, EyeOff, Edit2,
  LogIn, Square, Zap, AlertTriangle, Terminal,
  CheckCircle, Wifi, WifiOff, Clock, XCircle, ImageOff, ListPlus
} from 'lucide-react'

const BOT_API = (import.meta.env.VITE_BOT_SERVER_URL || '/bot-api').replace(/\/$/, '')

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BOT_API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const body = isJson ? await res.json() : await res.text()

  if (!res.ok) {
    const message =
      typeof body === 'object' && body?.error
        ? body.error
        : typeof body === 'string' && body
          ? body
          : `Request failed: ${res.status}`
    throw new Error(message)
  }

  return body
}

async function checkServer() {
  try {
    const data = await apiFetch('/health', { headers: {} })
    return !!data?.ok
  } catch {
    return false
  }
}

async function fetchBots() {
  return await apiFetch('/bots', { headers: {} })
}

async function loginBot(id) {
  return await apiFetch(`/bots/${id}/login`, { method: 'POST' })
}

async function startBot(id, campaignId) {
  return await apiFetch(`/bots/${id}/start`, {
    method: 'POST',
    body: JSON.stringify({ campaignId }),
  })
}

async function stopBot(id) {
  return await apiFetch(`/bots/${id}/stop`, { method: 'POST' })
}

function streamLogs(id, onLine) {
  const es = new EventSource(`${BOT_API}/bots/${id}/logs`)
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data?.line) onLine(data.line)
    } catch {}
  }
  es.onerror = () => {
    try { es.close() } catch {}
  }
  return () => {
    try { es.close() } catch {}
  }
}

async function setBotQueue(id, campaignIds) {
  return await apiFetch(`/bots/${id}/queue`, {
    method: 'POST',
    body: JSON.stringify({ campaignIds }),
  })
}

async function getBotQueue(id) {
  return await apiFetch(`/bots/${id}/queue`, { headers: {} })
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function CopyBtn({ value, label }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="inline-flex items-center gap-1.5 text-xs text-ink-500 hover:text-ink-300 bg-ink-800 border border-ink-700 rounded-lg px-2.5 py-1 transition-colors"
    >
      {copied ? <Check size={11} className="text-jade-400"/> : <Copy size={11}/>}
      <span className="font-mono text-ink-400">{label}</span>
    </button>
  )
}

function ProgressBar({ total, posted, failed, skipped }) {
  const pct = total ? Math.round((posted / total) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-ink-400">{posted} of {total} posted</span>
        <span className="text-ink-400">{pct}%</span>
      </div>
      <div className="h-2 bg-ink-700 rounded-full overflow-hidden">
        <div className="h-full bg-jade-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }}/>
      </div>
      <div className="flex gap-4 text-xs text-ink-500 mt-1.5">
        <span className="text-jade-400">{posted} posted</span>
        <span>{skipped} skipped</span>
        {failed > 0 && <span className="text-flame-400">{failed} failed</span>}
        <span>{total - posted - skipped - failed} pending</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Post Activity Log — shows every queue item with status
// ─────────────────────────────────────────────────────────
const STATUS_ICON = {
  posted:  <CheckCircle size={13} className="text-jade-400 flex-shrink-0"/>,
  failed:  <XCircle     size={13} className="text-flame-400 flex-shrink-0"/>,
  skipped: <XCircle     size={13} className="text-yellow-400 flex-shrink-0"/>,
  pending: <Clock       size={13} className="text-ink-500 flex-shrink-0"/>,
}
const STATUS_ROW = {
  posted:  'hover:bg-jade-500/5',
  failed:  'hover:bg-flame-500/5 bg-flame-500/3',
  skipped: 'hover:bg-yellow-500/5',
  pending: 'hover:bg-ink-800/30 opacity-60',
}

function PostActivityLog({ items }) {
  const [filter, setFilter] = useState('all')
  const filters = ['all', 'posted', 'failed', 'pending']
  const visible = filter === 'all' ? items : items.filter(i => i.status === filter)

  const sorted = [...visible].sort((a, b) => {
    const order = { failed: 0, posted: 1, skipped: 2, pending: 3 }
    const oa = order[a.status] ?? 4
    const ob = order[b.status] ?? 4
    if (oa !== ob) return oa - ob
    if (a.posted_at && b.posted_at) return new Date(b.posted_at) - new Date(a.posted_at)
    return 0
  })

  return (
    <div className="border-t border-ink-700">
      <div className="flex gap-1 px-4 pt-3 pb-2">
        {filters.map(f => {
          const count = f === 'all' ? items.length : items.filter(i => i.status === f).length
          return (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                filter === f ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'
              }`}>
              {f.charAt(0).toUpperCase() + f.slice(1)} <span className="opacity-60">({count})</span>
            </button>
          )
        })}
      </div>

      <div className="max-h-80 overflow-y-auto">
        {sorted.length === 0 ? (
          <p className="text-center text-ink-600 text-xs py-8">No items to show</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-ink-900 border-b border-ink-700">
              <tr>
                <th className="text-left px-4 py-2 text-ink-500 font-medium">Status</th>
                <th className="text-left px-4 py-2 text-ink-500 font-medium">Property</th>
                <th className="text-left px-4 py-2 text-ink-500 font-medium">Group</th>
                <th className="text-left px-4 py-2 text-ink-500 font-medium">Time</th>
                <th className="text-left px-4 py-2 text-ink-500 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/30">
              {sorted.map(item => (
                <tr key={item.id} className={`transition-colors ${STATUS_ROW[item.status] || ''}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {STATUS_ICON[item.status] || STATUS_ICON.pending}
                      <span className={`font-medium capitalize ${
                        item.status === 'posted'  ? 'text-jade-400'   :
                        item.status === 'failed'  ? 'text-flame-400'  :
                        item.status === 'skipped' ? 'text-yellow-400' : 'text-ink-500'
                      }`}>{item.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {item.properties?.photos?.[0]
                        ? <img src={item.properties.photos[0]} className="w-7 h-7 rounded object-cover flex-shrink-0" alt=""/>
                        : <div className="w-7 h-7 rounded bg-ink-700 flex items-center justify-center flex-shrink-0"><ImageOff size={10} className="text-ink-600"/></div>
                      }
                      <div>
                        <p className="text-ink-200 font-medium leading-tight">{item.properties?.title || '—'}</p>
                        {item.properties?.locality && <p className="text-ink-600 text-xs">{item.properties.locality}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-ink-400 max-w-[180px]">
                    <p className="truncate">{item.groups?.name || '—'}</p>
                  </td>
                  <td className="px-4 py-2.5 text-ink-500 whitespace-nowrap">
                    {item.posted_at
                      ? new Date(item.posted_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
                      : item.scheduled_at
                        ? <span className="text-ink-600">{new Date(item.scheduled_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>
                        : '—'
                    }
                  </td>
                  <td className="px-4 py-2.5 text-ink-600 max-w-[140px]">
                    {item.error_log
                      ? <span className="text-flame-500 text-xs truncate block" title={item.error_log}>{item.error_log.slice(0, 40)}</span>
                      : item.status === 'pending' ? <span className="text-ink-700">Waiting</span>
                      : null
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function CampaignRow({ campaign, onToggle }) {
  const [expanded, setExpanded] = useState(false)
  const items   = campaign.post_queue || []
  const posted  = items.filter(i => i.status === 'posted').length
  const failed  = items.filter(i => i.status === 'failed').length
  const skipped = items.filter(i => i.status === 'skipped').length

  const exportCSV = () => {
    const rows = items.map(q =>
      `"${q.properties?.title || ''}","${q.groups?.name || ''}","${q.status}","${q.scheduled_at||''}","${q.posted_at||''}","${q.error_log||''}"`
    ).join('\n')
    const blob = new Blob(['property,group,status,scheduled_at,posted_at,error\n' + rows], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `campaign-${campaign.id.slice(0,8)}.csv`
    a.click()
  }

  return (
    <div className="card overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between mb-3 gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <StatusBadge status={campaign.status}/>
              <span className="text-xs text-ink-500">
                {new Date(campaign.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
              </span>
              <CopyBtn value={campaign.id} label={`ID: ${campaign.id.slice(0,8)}…`}/>
            </div>
            <p className="text-sm font-medium text-ink-100">{campaign.notes || 'Untitled Campaign'}</p>
            {failed > 0 && (
              <p className="text-xs text-flame-400 mt-1 flex items-center gap-1">
                <XCircle size={11}/> {failed} post{failed > 1 ? 's' : ''} failed — see log below
              </p>
            )}
          </div>
          <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
            {campaign.status === 'active' && <button onClick={() => onToggle(campaign.id,'paused')} className="btn-ghost py-1.5 text-xs"><Pause size={13}/> Pause</button>}
            {campaign.status === 'paused' && <button onClick={() => onToggle(campaign.id,'active')} className="btn-ghost py-1.5 text-xs"><Play  size={13}/> Resume</button>}
            <button onClick={exportCSV} className="btn-ghost py-1.5 text-xs"><Download size={13}/> Export</button>
            <button onClick={() => setExpanded(e => !e)} className="btn-ghost py-1.5 text-xs">
              {expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
              {expanded ? 'Hide' : 'View Posts'}
            </button>
          </div>
        </div>
        <ProgressBar total={items.length} posted={posted} failed={failed} skipped={skipped}/>
      </div>
      {expanded && <PostActivityLog items={items}/>}
    </div>
  )
}

const EMPTY_BOT = { name: '', fb_email: '', fb_password: '' }

function BotFormModal({ open, initial, onClose, onSaved }) {
  const isEdit  = !!initial?.id
  const formKey = open ? (isEdit ? initial.id : 'new') : 'closed'
  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Bot Account' : 'Add Bot Account'} size="md">
      <BotFormInner key={formKey} initial={initial} isEdit={isEdit} onClose={onClose} onSaved={onSaved}/>
    </Modal>
  )
}

function BotFormInner({ initial, isEdit, onClose, onSaved }) {
  const defaults = {
    name: '', fb_email: '', fb_password: '',
    max_posts_per_day: 18, post_start_hour: 9, post_end_hour: 20,
    min_delay_seconds: 480, max_delay_seconds: 900,
    session_cap: 8, session_break_min: 120, session_break_max: 180,
  }
  const [form, setForm]     = useState(isEdit ? { ...defaults, ...initial } : defaults)
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const [tab,    setTab]    = useState('account')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.name.trim())        return setError('Bot name is required')
    if (!form.fb_email.trim())    return setError('Facebook email is required')
    if (!form.fb_password.trim()) return setError('Password is required')

    setError('')
    setSaving(true)

    try {
      const slug = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      const payload = {
        name:               form.name.trim(),
        fb_email:           form.fb_email.trim(),
        fb_password:        form.fb_password.trim(),
        session_file:       isEdit
          ? (initial.session_file || `fb_session_${slug}_${Date.now()}.json`)
          : `fb_session_${slug}_${Date.now()}.json`,
      }

      const query = isEdit
        ? supabase.from('bot_accounts').update(payload).eq('id', initial.id).select().single()
        : supabase.from('bot_accounts').insert([payload]).select().single()

      const { error } = await query
      if (error) throw error

      onSaved()
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save bot account')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-ink-900 rounded-xl p-1">
        {[['account','Account'], ['settings','Bot Settings']].map(([v,l]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${tab===v ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'account' && (
        <>
          <div className="bg-ink-700/50 border border-ink-600/50 rounded-xl p-3 text-xs text-ink-300 leading-relaxed">
            <span className="text-ink-100 font-semibold">Each bot = one Facebook account.</span>
            {' '}4 bots = ~72 posts/day. Credentials stored only in your private database.
          </div>
          <div>
            <label className="label">Bot Name</label>
            <input className="input" placeholder="e.g. Main Account" value={form.name} onChange={e => set('name', e.target.value)} autoFocus/>
          </div>
          <div>
            <label className="label">Facebook Email</label>
            <input className="input" type="email" placeholder="email@gmail.com" value={form.fb_email} onChange={e => set('fb_email', e.target.value)}/>
          </div>
          <div>
            <label className="label">Facebook Password</label>
            <div className="relative">
              <input className="input pr-10" type={showPw ? 'text' : 'password'} placeholder="••••••••"
                value={form.fb_password} onChange={e => set('fb_password', e.target.value)}/>
              <button type="button" onClick={() => setShowPw(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-300">
                {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
            <p className="text-xs text-ink-500 mt-1">Stored privately. Never shared.</p>
          </div>
        </>
      )}

      {tab === 'settings' && (
        <>
          <p className="text-xs text-ink-500">Bot timing settings are managed on the server side for now.</p>
        </>
      )}

      {error && <div className="bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 text-xs text-red-400">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={saving} className="btn-primary py-2.5 flex-1 disabled:opacity-50">
          {saving ? 'Saving…' : isEdit ? '💾 Save Changes' : '✅ Add Bot Account'}
        </button>
        <button type="button" onClick={onClose} className="btn-ghost py-2.5 px-5">Cancel</button>
      </div>
    </div>
  )
}

function LogViewerModal({ open, bot, onClose }) {
  const [lines, setLines] = useState([])
  const stopRef   = useRef(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (!open || !bot?.id) { setLines([]); return }
    stopRef.current = streamLogs(bot.id, line => setLines(prev => [...prev.slice(-299), line]))
    return () => { stopRef.current?.(); stopRef.current = null }
  }, [open, bot?.id])

  useEffect(() => { if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines, open])

  const color = (line) => {
    if (line.includes('✅') || line.includes('Posted')) return 'text-jade-400'
    if (line.includes('❌') || line.includes('failed')) return 'text-flame-400'
    if (line.includes('⚠️') || line.includes('Could')) return 'text-yellow-400'
    if (line.includes('⏳')) return 'text-ink-500'
    if (line.includes('🔐') || line.includes('🚀') || line.includes('📤')) return 'text-flame-300'
    return 'text-ink-300'
  }

  if (!bot) return null
  return (
    <Modal open={open} onClose={onClose} title={`Live Logs — ${bot.name}`} size="xl">
      <div>
        <div className="bg-ink-950 rounded-xl border border-ink-700 h-80 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
          {lines.length === 0
            ? <p className="text-ink-600 text-center mt-8">No log output yet.</p>
            : lines.map((line, i) => <div key={i} className={`${color(line)} py-0.5`}>{line}</div>)
          }
          <div ref={bottomRef}/>
        </div>
        <div className="flex justify-between items-center mt-3">
          <p className="text-xs text-ink-600">{lines.length} lines · live</p>
          <button onClick={() => setLines([])} className="btn-ghost py-1.5 text-xs">Clear</button>
        </div>
      </div>
    </Modal>
  )
}

function StartBotModal({ open, bot, campaigns, onClose, onConfirm }) {
  const [selected, setSelected] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => { if (open) setSelected('') }, [open])

  const activeCampaigns = (campaigns || []).filter(c => c.status === 'active')

  const handleStart = async () => {
    if (!selected) return
    setStarting(true)
    await onConfirm(bot.id, selected)
    setStarting(false)
    onClose()
  }

  if (!bot) return null
  return (
    <Modal open={open} onClose={onClose} title={`Start Bot — ${bot.name}`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-ink-400">Which campaign should this bot post for?</p>
        {activeCampaigns.length === 0 ? (
          <div className="bg-ink-800 border border-ink-700 rounded-xl p-4 text-center">
            <p className="text-sm text-ink-400">No active campaigns.</p>
            <p className="text-xs text-ink-500 mt-1">Create one from the Campaign Builder first.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeCampaigns.map(c => {
              const items   = c.post_queue || []
              const pending = items.filter(i => i.status === 'pending').length
              const posted  = items.filter(i => i.status === 'posted').length
              return (
                <div key={c.id} onClick={() => setSelected(c.id)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all select-none ${
                    selected === c.id ? 'border-flame-500 bg-flame-500/10' : 'border-ink-700 bg-ink-800/50 hover:border-ink-600'
                  }`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-ink-200">{c.notes || 'Untitled Campaign'}</p>
                    {selected === c.id && <Check size={14} className="text-flame-400"/>}
                  </div>
                  <p className="text-xs text-ink-500 mt-0.5">{pending} pending · {posted} posted · {items.length} total</p>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={handleStart} disabled={!selected || starting} className="btn-primary py-2.5 flex-1 disabled:opacity-40">
            {starting ? 'Starting…' : '🚀 Start Bot'}
          </button>
          <button onClick={onClose} className="btn-ghost py-2.5 px-4">Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

function CampaignQueueModal({ open, bot, campaigns, onClose }) {
  const [queue, setQueue] = useState([])
  const [saving, setSaving] = useState(false)
  const [serverUp, setServerUp] = useState(false)

  useEffect(() => {
    if (!open || !bot) return
    checkServer().then(up => {
      setServerUp(up)
      if (up) getBotQueue(bot.id).then(r => setQueue(r?.queue || [])).catch(() => setQueue([]))
    })
  }, [open, bot?.id])

  const activeCampaigns = (campaigns || []).filter(c => c.status === 'active')

  const addToQueue = (campaignId) => {
    if (queue.includes(campaignId)) return
    setQueue(q => [...q, campaignId])
  }

  const removeFromQueue = (campaignId) => setQueue(q => q.filter(id => id !== campaignId))

  const moveUp = (i) => {
    if (i === 0) return
    setQueue(q => { const n = [...q]; [n[i-1], n[i]] = [n[i], n[i-1]]; return n })
  }

  const saveQueue = async () => {
    setSaving(true)
    try { await setBotQueue(bot.id, queue) } catch {}
    setSaving(false)
    onClose()
  }

  if (!bot) return null

  return (
    <Modal open={open} onClose={onClose} title={`Campaign Queue — ${bot.name}`} size="md">
      <div className="space-y-4">
        <p className="text-xs text-ink-400 leading-relaxed">
          Add campaigns to this bot's queue. When the current campaign finishes, the bot automatically starts the next one.
        </p>

        <div>
          <label className="label">Queue ({queue.length} campaigns)</label>
          {queue.length === 0 ? (
            <div className="bg-ink-900 border border-ink-700 rounded-xl p-4 text-center text-ink-600 text-xs">
              No campaigns queued. Add from the list below.
            </div>
          ) : (
            <div className="space-y-2">
              {queue.map((cid, i) => {
                const c = campaigns.find(x => x.id === cid)
                const items = c?.post_queue || []
                const pending = items.filter(x => x.status === 'pending').length
                const posted = items.filter(x => x.status === 'posted').length
                return (
                  <div key={cid} className="flex items-center gap-2 bg-ink-800 border border-ink-700 rounded-xl px-3 py-2">
                    <span className="text-ink-600 text-xs w-5 flex-shrink-0">{i+1}.</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-ink-200 truncate">{c?.notes || cid.slice(0,8)+'…'}</p>
                      <p className="text-xs text-ink-600">{pending} pending · {posted} posted</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {i > 0 && (
                        <button onClick={() => moveUp(i)} className="text-ink-600 hover:text-ink-300 p-1 text-xs">↑</button>
                      )}
                      <button onClick={() => removeFromQueue(cid)} className="text-ink-600 hover:text-flame-400 p-1">
                        <XCircle size={13}/>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {activeCampaigns.length > 0 && (
          <div>
            <label className="label">Add Campaign</label>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {activeCampaigns.filter(c => !queue.includes(c.id)).map(c => {
                const items = c.post_queue || []
                const pending = items.filter(x => x.status === 'pending').length
                return (
                  <div key={c.id}
                    onClick={() => addToQueue(c.id)}
                    className="flex items-center justify-between px-3 py-2 bg-ink-900 border border-ink-700 rounded-xl cursor-pointer hover:border-flame-500/50 hover:bg-flame-500/5 transition-all">
                    <div>
                      <p className="text-xs font-medium text-ink-200">{c.notes || 'Untitled'}</p>
                      <p className="text-xs text-ink-600">{pending} pending posts</p>
                    </div>
                    <Plus size={13} className="text-flame-400 flex-shrink-0"/>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!serverUp && (
          <p className="text-xs text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
            ⚠️ Bot server not reachable right now.
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={saveQueue} disabled={saving} className="btn-primary py-2.5 flex-1">
            {saving ? 'Saving…' : '💾 Save Queue'}
          </button>
          <button onClick={onClose} className="btn-ghost py-2.5 px-4">Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

const BOT_STATUS = {
  idle:       { label: 'Ready',      dot: 'bg-ink-500',                badge: 'bg-ink-700 text-ink-400' },
  running:    { label: 'Posting',    dot: 'bg-jade-400 animate-pulse', badge: 'bg-jade-500/15 text-jade-400' },
  logging_in: { label: 'Logging in', dot: 'bg-yellow-400 animate-pulse', badge: 'bg-yellow-500/15 text-yellow-300' },
  paused:     { label: 'Paused',     dot: 'bg-yellow-400',             badge: 'bg-yellow-500/15 text-yellow-400' },
  error:      { label: 'Error',      dot: 'bg-flame-400',              badge: 'bg-flame-500/15 text-flame-400' },
}

function BotCard({ bot, campaigns, serverOnline, onEdit, onDelete, onRefresh }) {
  const [showPw, setShowPw] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [busy, setBusy] = useState(null)

  const sc = BOT_STATUS[bot.status] || BOT_STATUS.idle
  const isActive = bot.isRunning || bot.isLoggingIn
  const canLogin = serverOnline && !isActive
  const canStart = serverOnline && !isActive && bot.hasSession
  const canStop = serverOnline && isActive

  const doLogin = async () => {
    setBusy('login')
    try { await loginBot(bot.id) } catch {}
    onRefresh()
    setBusy(null)
    setLogOpen(true)
  }

  const doStart = async (botId, campaignId) => {
    setBusy('start')
    try { await startBot(botId, campaignId) } catch {}
    onRefresh()
    setBusy(null)
  }

  const doStop = async () => {
    if (!confirm(`Stop bot "${bot.name}"?`)) return
    setBusy('stop')
    try { await stopBot(bot.id) } catch {}
    onRefresh()
    setBusy(null)
  }

  return (
    <>
      <div className={`rounded-2xl border overflow-hidden ${bot.active !== false ? 'border-ink-700 bg-ink-800/30' : 'border-ink-700/30 opacity-50'}`}>
        <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${sc.dot}`}/>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-100 truncate">{bot.name}</p>
              <p className="text-xs text-ink-500 truncate">{bot.fb_email}</p>
            </div>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${sc.badge}`}>{sc.label}</span>
        </div>

        <div className="px-4 pb-2 flex items-center gap-5">
          <div className="text-center">
            <p className="text-xl font-bold text-ink-100">{bot.posts_today || 0}</p>
            <p className="text-xs text-ink-600">Today</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-ink-100">{bot.total_posts || 0}</p>
            <p className="text-xs text-ink-600">Total</p>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs font-mono text-ink-700">{showPw ? bot.fb_password : '••••••'}</span>
            <button onClick={() => setShowPw(s => !s)} className="text-ink-700 hover:text-ink-500 p-0.5">
              {showPw ? <EyeOff size={10}/> : <Eye size={10}/>}
            </button>
          </div>
        </div>

        <div className="px-4 pb-3">
          {bot.hasSession
            ? <p className="text-xs text-jade-500 flex items-center gap-1.5"><CheckCircle size={10}/> Session saved</p>
            : <p className="text-xs text-yellow-500 flex items-center gap-1.5"><AlertTriangle size={10}/> Login required</p>
          }
        </div>

        <div className="px-3 pb-3 space-y-2">
          {!bot.isRunning && (
            <button onClick={doLogin} disabled={!canLogin || busy === 'login'}
              className={`w-full py-2 text-xs rounded-xl border font-medium flex items-center justify-center gap-1.5 transition-all
                ${canLogin && busy !== 'login' ? 'bg-ink-700 border-ink-600 text-ink-300 hover:bg-ink-600' : 'bg-ink-800/50 border-ink-700/50 text-ink-600 cursor-not-allowed'}`}>
              {busy === 'login' ? <><span className="animate-spin inline-block">⟳</span> Logging in…</> : <><LogIn size={12}/> {bot.hasSession ? 'Re-login' : 'Login to Facebook'}</>}
            </button>
          )}
          {canStop ? (
            <button onClick={doStop} disabled={busy === 'stop'}
              className="w-full py-2 text-xs rounded-xl border font-medium flex items-center justify-center gap-1.5 bg-flame-500/10 border-flame-500/30 text-flame-400 hover:bg-flame-500/20 transition-all">
              <Square size={11}/> {busy === 'stop' ? 'Stopping…' : 'Stop Bot'}
            </button>
          ) : (
            <button onClick={() => setStartOpen(true)} disabled={!canStart || busy === 'start'}
              className={`w-full py-2 text-xs rounded-xl font-medium flex items-center justify-center gap-1.5 transition-all
                ${canStart && busy !== 'start' ? 'bg-jade-500 text-white hover:bg-jade-400' : 'bg-ink-700 text-ink-600 cursor-not-allowed border border-ink-600'}`}>
              <Zap size={12}/> {busy === 'start' ? 'Starting…' : canStart ? 'Start Posting' : 'Login First'}
            </button>
          )}
          <div className="flex gap-1.5">
            <button onClick={() => setLogOpen(true)} className="btn-ghost py-1.5 text-xs flex-1 flex items-center justify-center gap-1">
              <Terminal size={11}/> Logs
            </button>
            <button onClick={() => setQueueOpen(true)} className="btn-ghost py-1.5 text-xs px-3" title="Campaign Queue">
              <ListPlus size={12}/>
            </button>
            <button onClick={() => onEdit(bot)} className="btn-ghost py-1.5 text-xs px-3"><Edit2 size={12}/></button>
            <button onClick={() => onDelete(bot.id)} className="btn-ghost py-1.5 text-xs px-3 hover:text-flame-400"><Trash2 size={12}/></button>
          </div>
        </div>
        {!serverOnline && <div className="px-3 pb-3 text-center"><p className="text-xs text-ink-600">Bot API not reachable right now</p></div>}
      </div>

      <LogViewerModal open={logOpen} bot={bot} onClose={() => setLogOpen(false)}/>
      <StartBotModal open={startOpen} bot={bot} campaigns={campaigns} onClose={() => setStartOpen(false)} onConfirm={doStart}/>
      <CampaignQueueModal open={queueOpen} bot={bot} campaigns={campaigns} onClose={() => setQueueOpen(false)}/>
    </>
  )
}

function BotAccountsSection({ campaigns }) {
  const [bots, setBots] = useState([])
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState(false)
  const [formModal, setFormModal] = useState(null)

  const refresh = useCallback(async () => {
    const { data: dbBots, error: dbErr } = await supabase
      .from('bot_accounts').select('*').order('created_at')
    if (dbErr) console.error('bot_accounts:', dbErr.message)

    const serverUp = await checkServer()
    setOnline(serverUp)

    if (serverUp) {
      try {
        const serverBots = await fetchBots()
        if (Array.isArray(serverBots) && serverBots.length > 0) {
          setBots(serverBots)
          setLoading(false)
          return
        }
      } catch (e) {
        console.error('fetchBots error:', e.message)
      }
    }

    setBots((dbBots || []).map(b => ({
      ...b,
      hasSession: false,
      isRunning: false,
      isLoggingIn: false,
    })))
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh])

  const handleDelete = async (id) => {
    if (!confirm('Delete this bot account?')) return
    await supabase.from('bot_accounts').delete().eq('id', id)
    refresh()
  }

  const activeBots = bots.filter(b => b.active !== false)

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-700 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-flame-500/10 flex items-center justify-center">
            <Bot size={15} className="text-flame-400"/>
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-ink-100">Bot Accounts</h2>
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${online ? 'bg-jade-500/15 text-jade-400' : 'bg-ink-700 text-ink-500'}`}>
                {online ? <Wifi size={9}/> : <WifiOff size={9}/>}
                {online ? 'Server online' : 'Server offline'}
              </span>
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              {bots.length === 0 ? 'Add Facebook accounts to start automating'
                : `${activeBots.length} bot${activeBots.length !== 1 ? 's' : ''} · ~${activeBots.length * 18} posts/day`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="btn-ghost py-2 text-xs px-3"><RefreshCw size={12}/></button>
          <button onClick={() => setFormModal('add')} className="btn-primary py-2 text-xs"><Plus size={13}/> Add Bot Account</button>
        </div>
      </div>

      {!online && (
        <div className="px-5 py-3 border-b border-ink-700/40 bg-yellow-500/5 flex items-start gap-3">
          <WifiOff size={14} className="text-yellow-400 flex-shrink-0 mt-0.5"/>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-yellow-300">Bot API not reachable</p>
            <p className="text-xs text-yellow-400/70 mt-1.5">The dashboard is using <code className="text-flame-300">{BOT_API}</code>.</p>
          </div>
        </div>
      )}

      {!loading && bots.length === 0 ? (
        <div className="p-12 text-center">
          <Bot size={26} className="text-ink-600 mx-auto mb-3"/>
          <p className="text-ink-200 font-semibold mb-1">No bot accounts yet</p>
          <p className="text-ink-500 text-sm mb-5">3 bots = 54/day · 4 bots = 72/day · 5 bots = 90/day</p>
          <button onClick={() => setFormModal('add')} className="btn-primary py-2.5 px-6 inline-flex"><Plus size={14}/> Add First Bot</button>
        </div>
      ) : !loading && bots.length > 0 ? (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {bots.map(bot => (
            <BotCard key={bot.id} bot={bot} campaigns={campaigns} serverOnline={online}
              onEdit={b => setFormModal(b)} onDelete={handleDelete} onRefresh={refresh}/>
          ))}
        </div>
      ) : null}

      <BotFormModal
        open={formModal !== null}
        initial={formModal === 'add' ? null : formModal}
        onClose={() => setFormModal(null)}
        onSaved={refresh}
      />
    </div>
  )
}

function ServerBanner({ online }) {
  if (online) return null
  return (
    <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/25 rounded-xl p-4 mb-6">
      <WifiOff size={16} className="text-yellow-400 flex-shrink-0 mt-0.5"/>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-yellow-300">Bot API not reachable</p>
        <p className="text-xs text-yellow-400/70 mt-1 mb-2">
          This dashboard expects the bot API at <code className="text-flame-300">{BOT_API}</code>.
        </p>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { campaigns, loading, refetch, updateStatus } = useCampaigns()
  const [serverOnline, setServerOnline] = useState(false)

  useEffect(() => {
    const check = async () => setServerOnline(await checkServer())
    check()
    const id = setInterval(check, 10000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const id = setInterval(refetch, 30000)
    return () => clearInterval(id)
  }, [refetch])

  const active    = campaigns.filter(c => c.status === 'active')
  const paused    = campaigns.filter(c => c.status === 'paused')
  const completed = campaigns.filter(c => c.status === 'completed')
  const allItems  = campaigns.flatMap(c => c.post_queue || [])
  const totalPosted  = allItems.filter(q => q.status === 'posted').length
  const totalPending = allItems.filter(q => q.status === 'pending').length
  const totalFailed  = allItems.filter(q => q.status === 'failed').length

  return (
    <div className="p-8 fade-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">Dashboard</h1>
          <p className="text-sm text-ink-400 mt-0.5">Live campaign status · auto-refreshes every 30s</p>
        </div>
        <button onClick={refetch} className="btn-ghost"><RefreshCw size={14}/> Refresh</button>
      </div>

      <ServerBanner online={serverOnline}/>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active Campaigns', val: active.length,    color: 'text-jade-400' },
          { label: 'Posts Sent',       val: totalPosted,      color: 'text-ink-100' },
          { label: 'Pending',          val: totalPending,     color: 'text-ink-100' },
          { label: 'Failed',           val: totalFailed,      color: totalFailed > 0 ? 'text-flame-400' : 'text-ink-100' },
        ].map(s => (
          <div key={s.label} className="card p-4">
            <p className={`text-2xl font-semibold ${s.color}`}>{s.val}</p>
            <p className="text-xs text-ink-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mb-8"><BotAccountsSection campaigns={campaigns}/></div>

      <h2 className="text-xs font-semibold text-ink-500 uppercase tracking-wider mb-3">Campaigns</h2>
      {loading ? (
        <div className="space-y-4">{[...Array(2)].map((_,i) => <div key={i} className="card h-32 animate-pulse"/>)}</div>
      ) : campaigns.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-ink-400">No campaigns yet. Build one from the Campaign Builder.</p>
        </div>
      ) : (
        <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: '600px' }}>
          {[...active,...paused,...completed].map(c => (
            <CampaignRow key={c.id} campaign={c} onToggle={updateStatus}/>
          ))}
        </div>
      )}
    </div>
  )
}