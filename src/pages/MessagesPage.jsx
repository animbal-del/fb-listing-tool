import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMessages } from '../hooks/useMessages'
import { hasLink, canTweak, tweakMessage } from '../lib/messageTweaks'
import Modal from '../components/Modal'
import { Plus, Pencil, Trash2, RefreshCw, AlertTriangle, AlertCircle, Megaphone, MessageSquare, Shuffle } from 'lucide-react'

// ── Message form (add / edit) ─────────────────────────────
function MessageForm({ initial = {}, onSave, onCancel }) {
  const [title, setTitle]   = useState(initial.title || '')
  const [body, setBody]     = useState(initial.body || '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!title.trim()) return setError('Title is required')
    if (!body.trim())  return setError('Message text is required')
    setError('')
    setSaving(true)
    try {
      await onSave({ title: title.trim(), body: body.replace(/\s+$/, '') })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const tweakable = body.trim() && canTweak(body)

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Title * <span className="text-ink-600 font-normal">(only you see this)</span></label>
        <input className="input" placeholder="e.g. Looking for flat owners in Kharadi"
          value={title} onChange={e => setTitle(e.target.value)} autoFocus />
      </div>

      <div>
        <label className="label">Message * <span className="text-ink-600 font-normal">(posted exactly as typed)</span></label>
        <textarea className="input min-h-[220px] font-sans leading-relaxed"
          placeholder={'Hi everyone 👋\nWe have zero-brokerage flats in Kharadi…\nDM for details'}
          value={body} onChange={e => setBody(e.target.value)} />
        <p className="text-xs text-ink-600 mt-1">{body.length} characters</p>
      </div>

      {hasLink(body) && (
        <div className="flex items-start gap-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>This message contains a link. Many groups send posts with links to admin approval, so some posts may stay pending.</span>
        </div>
      )}

      {body.trim() && (
        <div className="text-xs text-ink-400 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Shuffle size={12} />
              {tweakable
                ? 'Group variations available — emojis, greeting, closing line and bullets will vary per group.'
                : 'No variations possible — every group will get this exact text.'}
            </span>
            {tweakable && (
              <button type="button" onClick={() => setPreviewOpen(o => !o)} className="text-flame-400 hover:text-flame-300 shrink-0">
                {previewOpen ? 'Hide preview' : 'Preview'}
              </button>
            )}
          </div>
          {previewOpen && tweakable && (
            <div className="grid sm:grid-cols-2 gap-2 mt-3">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="bg-ink-950 border border-ink-700 rounded-lg p-2.5">
                  <p className="text-[11px] text-ink-500 mb-1">Group {i + 1}{i === 0 ? ' (original)' : ''}</p>
                  <p className="whitespace-pre-wrap text-ink-200 leading-relaxed">{tweakMessage(body, i)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-flame-400 bg-flame-500/10 border border-flame-500/20 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save Message'}
        </button>
      </div>
    </form>
  )
}

// ── Page ──────────────────────────────────────────────────
export default function MessagesPage() {
  const navigate = useNavigate()
  const { messages, loading, error, refetch, create, update, remove } = useMessages()
  const [formOpen, setFormOpen]   = useState(false)
  const [editing, setEditing]     = useState(null)
  const [confirmDel, setConfirm]  = useState(null)
  const [deleteError, setDeleteError] = useState('')

  const openNew  = () => { setEditing(null); setFormOpen(true) }
  const openEdit = (m) => { setEditing(m); setFormOpen(true) }
  const close    = () => { setFormOpen(false); setEditing(null) }

  const save = async (payload) => {
    if (editing) await update(editing.id, payload)
    else await create(payload)
    close()
  }

  const handleDelete = async () => {
    setDeleteError('')
    try {
      await remove(confirmDel.id)
      setConfirm(null)
    } catch (err) {
      setDeleteError(err.message)
    }
  }

  return (
    <div className="p-8 fade-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">Messages</h1>
          <p className="text-sm text-ink-400 mt-0.5">
            Text posts you can send to groups as a message campaign · {messages.length} saved
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={refetch} title="Refresh">
            <RefreshCw size={15}/>
          </button>
          <button className="btn-primary" onClick={openNew}>
            <Plus size={16}/> New Message
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-5 flex items-center gap-2 text-sm text-flame-400 bg-flame-500/10 border border-flame-500/20 rounded-lg px-4 py-3">
          <AlertCircle size={15}/> {error}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-ink-500 text-sm">Loading messages…</div>
      ) : messages.length === 0 ? (
        <div className="card p-10 text-center">
          <MessageSquare size={28} className="mx-auto text-ink-600 mb-3"/>
          <p className="text-ink-300 font-medium">No messages yet</p>
          <p className="text-sm text-ink-500 mt-1 mb-4">Write a message once, then post it to many groups from New Campaign.</p>
          <button className="btn-primary mx-auto" onClick={openNew}><Plus size={16}/> New Message</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {messages.map(m => (
            <div key={m.id} className="card p-4 flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-ink-100">{m.title}</p>
                <span className="text-[11px] text-ink-600 whitespace-nowrap">
                  Edited {new Date(m.updated_at || m.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                </span>
              </div>
              <p className="text-sm text-ink-400 whitespace-pre-wrap line-clamp-5 leading-relaxed flex-1">{m.body}</p>
              <div className="flex items-center gap-3 mt-3 text-[11px] text-ink-500">
                {hasLink(m.body) && <span className="flex items-center gap-1 text-yellow-500"><AlertTriangle size={11}/> Contains link</span>}
                <span className="flex items-center gap-1"><Shuffle size={11}/> {canTweak(m.body) ? 'Variations available' : 'No variations'}</span>
              </div>
              <div className="flex gap-2 mt-3 pt-3 border-t border-ink-800">
                <button className="btn-primary py-1.5 text-xs"
                  onClick={() => navigate('/campaign', { state: { messageId: m.id } })}>
                  <Megaphone size={13}/> Use in campaign
                </button>
                <button className="btn-ghost py-1.5 text-xs" onClick={() => openEdit(m)}>
                  <Pencil size={13}/> Edit
                </button>
                <button className="btn-ghost py-1.5 text-xs ml-auto text-flame-400" onClick={() => { setDeleteError(''); setConfirm(m) }}>
                  <Trash2 size={13}/> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={formOpen} title={editing ? 'Edit Message' : 'New Message'} onClose={close} size="lg">
        {formOpen && <MessageForm initial={editing || {}} onSave={save} onCancel={close} />}
      </Modal>

      <Modal open={!!confirmDel} title="Delete Message" onClose={() => setConfirm(null)} size="sm">
        <p className="text-sm text-ink-300 mb-1">Delete <span className="font-semibold text-ink-100">"{confirmDel?.title}"</span>?</p>
        <p className="text-xs text-ink-500 mb-4">Campaigns already launched with this message keep posting their saved copy.</p>
        {deleteError && <p className="text-sm text-flame-400 mb-3">{deleteError}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="btn-primary bg-flame-600" onClick={handleDelete}><Trash2 size={14}/> Delete</button>
        </div>
      </Modal>
    </div>
  )
}
