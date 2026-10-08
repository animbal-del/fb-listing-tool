import { useState, useRef } from 'react'
import { useGroups } from '../hooks/useGroups'
import Modal from '../components/Modal'
import { Plus, Search, Pencil, Trash2, Upload, ExternalLink, Users, ToggleLeft, ToggleRight, AlertCircle, RefreshCw } from 'lucide-react'

// ── CSV import ────────────────────────────────────────────
// Columns are matched by header name (any order). member_count accepts
// "3000", "3,000", "3.0K", "12.5k", "1.2M" (as Facebook shows them).
function parseCsvLine(line) {
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out
}

function parseMemberCount(value) {
  const m = String(value ?? '').replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?/)
  if (!m) return null
  const n = parseFloat(m[1]) * (/k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1)
  return Math.round(n)
}

const CSV_COLUMNS = {
  name:         ['name', 'group name', 'group_name', 'group'],
  fb_url:       ['fb_url', 'url', 'facebook url', 'group url', 'link'],
  locality_tag: ['locality_tag', 'locality', 'area', 'locality tag'],
  member_count: ['member_count', 'members', 'member count', 'member_count ', 'membercount'],
}

function parseGroupsCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim())
  const idx = {}
  for (const [key, names] of Object.entries(CSV_COLUMNS)) idx[key] = header.findIndex(h => names.includes(h))
  // No recognisable header → fall back to positional: name, fb_url, locality_tag, member_count
  if (idx.name < 0 || idx.fb_url < 0) Object.assign(idx, { name: 0, fb_url: 1, locality_tag: 2, member_count: 3 })

  return lines.slice(1).map(line => {
    const cols = parseCsvLine(line)
    const get = key => (idx[key] >= 0 ? cols[idx[key]] || '' : '')
    return {
      name:         get('name'),
      fb_url:       get('fb_url'),
      locality_tag: get('locality_tag') || null,
      member_count: parseMemberCount(get('member_count')),
    }
  }).filter(r => r.name && r.fb_url)
}

// ── Group form (add / edit) ───────────────────────────────
function GroupForm({ initial = {}, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: '', fb_url: '', locality_tag: '', member_count: '', ...initial
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim())   return setError('Group name is required')
    if (!form.fb_url.trim()) return setError('Facebook URL is required')
    setError('')
    setSaving(true)
    try {
      await onSave({ ...form, member_count: form.member_count ? parseInt(form.member_count) : null })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Group Name *</label>
        <input className="input" required placeholder="Mumbai Flats For Rent"
          value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
      </div>
      <div>
        <label className="label">Facebook Group URL *</label>
        <input className="input" required placeholder="https://www.facebook.com/groups/..."
          value={form.fb_url} onChange={e => set('fb_url', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Locality Tag</label>
          <input className="input" placeholder="Bandra"
            value={form.locality_tag} onChange={e => set('locality_tag', e.target.value)} />
        </div>
        <div>
          <label className="label">Member Count</label>
          <input className="input" type="number" placeholder="12400"
            value={form.member_count} onChange={e => set('member_count', e.target.value)} />
        </div>
      </div>
      {error && (
        <div className="bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
      <div className="flex gap-3 pt-2">
        <button type="submit" className="btn-primary flex-1 justify-center" disabled={saving}>
          {saving ? 'Saving…' : 'Save Group'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// ── Main page ─────────────────────────────────────────────
export default function GroupsPage() {
  const { groups, loading, error, refetch, create, update, remove, toggleActive, bulkImport } = useGroups()
  const [search,    setSearch]    = useState('')
  const [locality,  setLocality]  = useState('all')
  const [showForm,  setShowForm]  = useState(false)
  const [editing,   setEditing]   = useState(null)
  const [confirmDel,setConfirm]   = useState(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef()

  const localities = ['all', ...new Set(groups.map(g => g.locality_tag).filter(Boolean))]

  const filtered = groups.filter(g => {
    const matchSearch   = !search   || g.name.toLowerCase().includes(search.toLowerCase())
    const matchLocality = locality === 'all' || g.locality_tag === locality
    return matchSearch && matchLocality
  })

  const handleCSV = async (e) => {
    const file = e.target.files[0]; if (!file) return
    setImporting(true)
    try {
      const rows = parseGroupsCsv(await file.text())
      if (!rows.length) return alert('No valid rows found. Columns: name, fb_url, locality_tag, member_count')
      const { added, updated, unchanged } = await bulkImport(rows)
      alert(`Import done — ${added} added, ${updated} updated${unchanged ? `, ${unchanged} already up to date` : ''}`)
    } catch (err) {
      alert('Import failed: ' + err.message)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  const handleSave = async (payload) => {
    if (editing) { await update(editing.id, payload); setEditing(null) }
    else         { await create(payload);              setShowForm(false) }
  }

  const handleDelete = async () => {
    if (!confirmDel) return
    await remove(confirmDel.id)
    setConfirm(null)
  }

  return (
    <div className="p-8 fade-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">Groups</h1>
          <p className="text-sm text-ink-400 mt-0.5">
            {groups.filter(g => g.active).length} active · {groups.length} total
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={refetch} title="Refresh">
            <RefreshCw size={15}/>
          </button>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
            <Upload size={15}/> {importing ? 'Importing…' : 'CSV Import'}
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleCSV}/>
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            <Plus size={16}/> Add Group
          </button>
        </div>
      </div>

      {/* CSV hint */}
      <div className="mb-5 px-4 py-3 rounded-lg bg-ink-800 border border-ink-700 text-xs text-ink-400">
        CSV format: <span className="font-mono text-ink-300">name, fb_url, locality_tag, member_count</span> — one group per row, header row required. member_count is optional (e.g. 3000 or 3.0K). Groups already in the list are updated, not duplicated.
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/25 rounded-xl p-4 mb-5">
          <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5"/>
          <div>
            <p className="text-sm font-medium text-red-300">Could not load groups</p>
            <p className="text-xs text-red-400/70 mt-1">{error}</p>
            <button onClick={refetch} className="text-xs text-red-400 underline mt-2">Try again</button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"/>
          <input className="input pl-9" placeholder="Search groups…"
            value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        {localities.map(l => (
          <button key={l} onClick={() => setLocality(l)}
            className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              locality === l
                ? 'bg-ink-700 border-ink-500 text-ink-100'
                : 'bg-transparent border-ink-700 text-ink-400 hover:border-ink-500'
            }`}>
            {l === 'all' ? 'All Areas' : l}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="card divide-y divide-ink-700">
          {[...Array(5)].map((_, i) => <div key={i} className="h-14 animate-pulse bg-ink-800"/>)}
        </div>
      ) : filtered.length === 0 && !error ? (
        <div className="card p-12 flex flex-col items-center justify-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-ink-700 flex items-center justify-center mb-4">
            <Users size={24} className="text-ink-400"/>
          </div>
          <p className="text-ink-300 font-medium mb-1">No groups yet</p>
          <p className="text-ink-500 text-sm mb-4">Add groups manually or import via CSV</p>
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            <Plus size={14}/> Add First Group
          </button>
        </div>
      ) : filtered.length > 0 ? (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 bg-ink-800/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-400 uppercase tracking-wider">Group Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-400 uppercase tracking-wider hidden md:table-cell">Locality</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-400 uppercase tracking-wider hidden lg:table-cell">Members</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-400 uppercase tracking-wider">Active</th>
                <th className="px-4 py-3"/>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {filtered.map(g => (
                <tr key={g.id} className="hover:bg-ink-800/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium ${g.active ? 'text-ink-100' : 'text-ink-500 line-through'}`}>
                        {g.name}
                      </span>
                      <a href={g.fb_url} target="_blank" rel="noreferrer"
                        className="text-ink-600 hover:text-ink-300 transition-colors">
                        <ExternalLink size={12}/>
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-400 hidden md:table-cell">{g.locality_tag || '—'}</td>
                  <td className="px-4 py-3 text-ink-400 hidden lg:table-cell">
                    {g.member_count?.toLocaleString() || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleActive(g.id, g.active)} className="text-ink-400 hover:text-ink-200 transition-colors">
                      {g.active
                        ? <ToggleRight size={20} className="text-jade-400"/>
                        : <ToggleLeft  size={20}/>
                      }
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setEditing(g)}
                        className="p-1.5 rounded hover:bg-ink-700 text-ink-400 hover:text-ink-200 transition-colors">
                        <Pencil size={13}/>
                      </button>
                      <button onClick={() => setConfirm(g)}
                        className="p-1.5 rounded hover:bg-flame-500/10 text-ink-400 hover:text-flame-400 transition-colors">
                        <Trash2 size={13}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Modals */}
      <Modal open={showForm} title="Add Group" onClose={() => setShowForm(false)}>
        <GroupForm onSave={handleSave} onCancel={() => setShowForm(false)}/>
      </Modal>

      <Modal open={!!editing} title="Edit Group" onClose={() => setEditing(null)}>
        <GroupForm initial={editing || {}} onSave={handleSave} onCancel={() => setEditing(null)}/>
      </Modal>

      <Modal open={!!confirmDel} title="Delete Group" onClose={() => setConfirm(null)} size="sm">
        <div>
          <p className="text-ink-300 text-sm mb-1">Are you sure you want to delete</p>
          <p className="text-ink-100 font-semibold mb-4">"{confirmDel?.name}"?</p>
          <p className="text-ink-500 text-xs mb-6">This cannot be undone.</p>
          <div className="flex gap-3">
            <button onClick={handleDelete}
              className="btn-primary flex-1 justify-center" style={{ background: '#dc2626' }}>
              Delete
            </button>
            <button onClick={() => setConfirm(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
