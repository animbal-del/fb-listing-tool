import { useState, useMemo } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useGroups }     from '../hooks/useGroups'
import { useCampaigns }  from '../hooks/useCampaigns'
import { supabase }      from '../lib/supabase'
import { useNavigate }   from 'react-router-dom'
import {
  CheckSquare, Square, AlertTriangle, ChevronRight,
  Loader2, Search, MapPin
} from 'lucide-react'

const STEPS = ['Select Listings', 'Select Groups', 'Review Queue', 'Settings & Launch']

export default function CampaignPage() {
  const navigate = useNavigate()
  const { properties } = useProperties()
  const { groups }     = useGroups()
  const { createCampaign } = useCampaigns()

  const [step, setStep]             = useState(0)
  const [selectedProps, setSelectedProps]   = useState(new Set())
  const [selectedGroups, setSelectedGroups] = useState(new Set())
  const [dupWarnings, setDupWarnings]       = useState({})

  // Filters
  const [propSearch,     setPropSearch]     = useState('')
  const [propLocality,   setPropLocality]   = useState('all')
  const [groupSearch,    setGroupSearch]    = useState('')
  const [groupLocality,  setGroupLocality]  = useState('all')

  // Settings
  const [notes,       setNotes]       = useState('')
  const [postsPerDay, setPostsPerDay] = useState(18)
  const [startHour,   setStartHour]   = useState(9)
  const [endHour,     setEndHour]     = useState(20)
  const [jitter,      setJitter]      = useState(false)
  const [launching,   setLaunching]   = useState(false)
  const [error,       setError]       = useState('')

  const availableProps = properties.filter(p => p.status === 'available')
  const activeGroups   = groups.filter(g => g.active)

  // Locality lists
  const propLocalities  = ['all', ...new Set(availableProps.map(p => p.locality).filter(Boolean))]
  const groupLocalities = ['all', ...new Set(activeGroups.map(g => g.locality_tag).filter(Boolean))]

  // Filtered lists
  const filteredProps = availableProps.filter(p => {
    const matchSearch   = !propSearch   || p.title.toLowerCase().includes(propSearch.toLowerCase())
    const matchLocality = propLocality  === 'all' || p.locality === propLocality
    return matchSearch && matchLocality
  })

  const filteredGroups = activeGroups.filter(g => {
    const matchSearch   = !groupSearch   || g.name.toLowerCase().includes(groupSearch.toLowerCase())
    const matchLocality = groupLocality  === 'all' || g.locality_tag === groupLocality
    return matchSearch && matchLocality
  })

  const toggleProp  = (id) => setSelectedProps(s  => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleGroup = (id) => setSelectedGroups(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const selectAllFilteredProps  = () => setSelectedProps(s  => { const n = new Set(s); filteredProps.forEach(p  => n.add(p.id));  return n })
  const selectAllFilteredGroups = () => setSelectedGroups(s => { const n = new Set(s); filteredGroups.forEach(g => n.add(g.id)); return n })
  const clearAllProps  = () => setSelectedProps(new Set())
  const clearAllGroups = () => setSelectedGroups(new Set())

  const queueItems = useMemo(() => {
    const items = []
    for (const pid of selectedProps) {
      for (const gid of selectedGroups) {
        items.push({ property_id: pid, group_id: gid, duplicate_warned: !!dupWarnings[`${pid}-${gid}`] })
      }
    }
    return items
  }, [selectedProps, selectedGroups, dupWarnings])

  const checkDuplicates = async () => {
    const warnings = {}
    for (const pid of selectedProps) {
      for (const gid of selectedGroups) {
        try {
          const { data } = await supabase.rpc('check_duplicate_post', { p_property_id: pid, p_group_id: gid, p_days: 14 })
          if (data) warnings[`${pid}-${gid}`] = true
        } catch {}
      }
    }
    setDupWarnings(warnings)
  }

  const goToStep = async (next) => {
    if (next === 2) await checkDuplicates()
    setStep(next)
  }

  const launch = async () => {
    setError(''); setLaunching(true)
    try {
      await createCampaign({ notes, postsPerDay, startHour, endHour, jitter, queueItems })
      navigate('/dashboard')
    } catch (err) { setError(err.message) }
    finally { setLaunching(false) }
  }

  const propMap  = Object.fromEntries(properties.map(p => [p.id, p]))
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g]))
  const dupCount = Object.keys(dupWarnings).length

  return (
    <div className="p-8 fade-up">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-ink-100">New Campaign</h1>
        <p className="text-sm text-ink-400 mt-0.5">Select listings and groups to build a posting queue</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {STEPS.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              i === step ? 'bg-flame-500/20 text-flame-400 border border-flame-500/30'
              : i < step  ? 'text-jade-400' : 'text-ink-500'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                i < step ? 'bg-jade-500 text-white' : i === step ? 'bg-flame-500 text-white' : 'bg-ink-700 text-ink-500'}`}>
                {i < step ? '✓' : i + 1}
              </span>
              {s}
            </div>
            {i < STEPS.length - 1 && <ChevronRight size={14} className="text-ink-600"/>}
          </div>
        ))}
      </div>

      {/* ── STEP 0 — Select Listings ── */}
      {step === 0 && (
        <div>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-sm text-ink-400">{selectedProps.size} selected</p>
            <div className="flex gap-2">
              <button onClick={selectAllFilteredProps} className="text-sm text-flame-400 hover:text-flame-300">+ Select Visible</button>
              {selectedProps.size > 0 && <button onClick={clearAllProps} className="text-sm text-ink-500 hover:text-ink-300">Clear All</button>}
            </div>
          </div>

          {/* Locality filter pills */}
          {propLocalities.length > 1 && (
            <div className="flex gap-2 mb-3 flex-wrap">
              <MapPin size={13} className="text-ink-500 mt-2 flex-shrink-0"/>
              {propLocalities.map(l => (
                <button key={l} onClick={() => setPropLocality(l)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    propLocality === l ? 'bg-flame-500/20 border-flame-500/40 text-flame-400' : 'border-ink-700 text-ink-500 hover:border-ink-500'
                  }`}>
                  {l === 'all' ? 'All Localities' : l}
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="relative mb-4 max-w-xs">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"/>
            <input className="input pl-9 text-sm" placeholder="Search listings…"
              value={propSearch} onChange={e => setPropSearch(e.target.value)}/>
          </div>

          {filteredProps.length === 0 ? (
            <div className="card p-8 text-center text-ink-500 text-sm">No listings match your filters</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
              {filteredProps.map(p => {
                const sel = selectedProps.has(p.id)
                return (
                  <div key={p.id} onClick={() => toggleProp(p.id)}
                    className={`card p-4 cursor-pointer transition-all select-none ${sel ? 'border-flame-500/50 bg-flame-500/5' : 'hover:border-ink-600'}`}>
                    <div className="flex items-start gap-3">
                      {sel ? <CheckSquare size={16} className="text-flame-400 shrink-0 mt-0.5"/> : <Square size={16} className="text-ink-500 shrink-0 mt-0.5"/>}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink-100 truncate">{p.title}</p>
                        <p className="text-xs text-ink-400 mt-0.5">
                          {p.locality && <span className="text-ink-500">📍 {p.locality}</span>}
                          {p.rent && <span className="ml-2">₹{p.rent.toLocaleString()}/mo</span>}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex justify-end">
            <button className="btn-primary" disabled={!selectedProps.size} onClick={() => setStep(1)}>
              Next: Select Groups <ChevronRight size={15}/>
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 1 — Select Groups ── */}
      {step === 1 && (
        <div>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-sm text-ink-400">{selectedGroups.size} selected</p>
            <div className="flex gap-2">
              <button onClick={selectAllFilteredGroups} className="text-sm text-flame-400 hover:text-flame-300">+ Select Visible</button>
              {selectedGroups.size > 0 && <button onClick={clearAllGroups} className="text-sm text-ink-500 hover:text-ink-300">Clear All</button>}
            </div>
          </div>

          {/* Locality filter pills */}
          {groupLocalities.length > 1 && (
            <div className="flex gap-2 mb-3 flex-wrap">
              <MapPin size={13} className="text-ink-500 mt-2 flex-shrink-0"/>
              {groupLocalities.map(l => (
                <button key={l} onClick={() => setGroupLocality(l)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    groupLocality === l ? 'bg-flame-500/20 border-flame-500/40 text-flame-400' : 'border-ink-700 text-ink-500 hover:border-ink-500'
                  }`}>
                  {l === 'all' ? 'All Areas' : l}
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="relative mb-4 max-w-xs">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"/>
            <input className="input pl-9 text-sm" placeholder="Search groups…"
              value={groupSearch} onChange={e => setGroupSearch(e.target.value)}/>
          </div>

          {filteredGroups.length === 0 ? (
            <div className="card p-8 text-center text-ink-500 text-sm">No groups match your filters</div>
          ) : (
            <div className="card overflow-hidden mb-6">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-ink-700/50">
                  {filteredGroups.map(g => {
                    const sel = selectedGroups.has(g.id)
                    return (
                      <tr key={g.id} onClick={() => toggleGroup(g.id)}
                        className={`cursor-pointer transition-colors select-none ${sel ? 'bg-flame-500/5' : 'hover:bg-ink-800/30'}`}>
                        <td className="px-4 py-3 w-8">
                          {sel ? <CheckSquare size={15} className="text-flame-400"/> : <Square size={15} className="text-ink-500"/>}
                        </td>
                        <td className="px-4 py-3 text-ink-100 font-medium">{g.name}</td>
                        <td className="px-4 py-3 text-ink-500 text-xs">
                          {g.locality_tag && <span className="flex items-center gap-1"><MapPin size={10}/>{g.locality_tag}</span>}
                        </td>
                        <td className="px-4 py-3 text-ink-500 text-xs text-right">{g.member_count?.toLocaleString() || ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(0)}>← Back</button>
            <button className="btn-primary" disabled={!selectedGroups.size} onClick={() => goToStep(2)}>
              Next: Review Queue <ChevronRight size={15}/>
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2 — Review Queue ── */}
      {step === 2 && (
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <p className="text-sm text-ink-400">{queueItems.length} posts queued</p>
            {dupCount > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-yellow-400">
                <AlertTriangle size={14}/> {dupCount} duplicate warning{dupCount > 1 ? 's' : ''}
              </div>
            )}
          </div>
          <div className="card overflow-hidden mb-6 max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-ink-800 border-b border-ink-700">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-400 uppercase tracking-wider">Property</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-400 uppercase tracking-wider">Group</th>
                  <th className="px-4 py-2.5"/>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/50">
                {queueItems.map((item, i) => {
                  const isDup = dupWarnings[`${item.property_id}-${item.group_id}`]
                  return (
                    <tr key={i} className={isDup ? 'bg-yellow-500/5' : ''}>
                      <td className="px-4 py-2.5 text-ink-200">{propMap[item.property_id]?.title}</td>
                      <td className="px-4 py-2.5 text-ink-400">{groupMap[item.group_id]?.name}</td>
                      <td className="px-4 py-2.5 text-right">
                        {isDup && <span className="inline-flex items-center gap-1 text-xs text-yellow-400"><AlertTriangle size={11}/> Recently posted</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <button className="btn-primary" onClick={() => setStep(3)}>Next: Settings <ChevronRight size={15}/></button>
          </div>
        </div>
      )}

      {/* ── STEP 3 — Settings & Launch ── */}
      {step === 3 && (
        <div className="max-w-lg">
          <div className="card p-6 space-y-5 mb-6">
            <div>
              <label className="label">Campaign Notes (optional)</label>
              <input className="input" placeholder="e.g. March week 1 — Pune groups"
                value={notes} onChange={e => setNotes(e.target.value)}/>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Max Posts / Day</label>
                <input className="input" type="number" min={1} max={25} value={postsPerDay}
                  onChange={e => setPostsPerDay(parseInt(e.target.value))}/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Post From (hour)</label>
                <input className="input" type="number" min={0} max={23} value={startHour}
                  onChange={e => setStartHour(parseInt(e.target.value))}/>
              </div>
              <div>
                <label className="label">Post Until (hour)</label>
                <input className="input" type="number" min={0} max={23} value={endHour}
                  onChange={e => setEndHour(parseInt(e.target.value))}/>
              </div>
            </div>
            <div className="flex items-center justify-between py-2 border-t border-ink-700">
              <div>
                <p className="text-sm font-medium text-ink-200">Text Jitter</p>
                <p className="text-xs text-ink-500">Slightly vary each post to avoid detection</p>
              </div>
              <button onClick={() => setJitter(j => !j)}
                className={`w-11 h-6 rounded-full transition-colors relative ${jitter ? 'bg-flame-500' : 'bg-ink-700'}`}>
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${jitter ? 'translate-x-6' : 'translate-x-1'}`}/>
              </button>
            </div>
          </div>

          <div className="card p-4 mb-6 bg-ink-800/50">
            <p className="text-sm text-ink-300 font-medium mb-1">Campaign Summary</p>
            <p className="text-xs text-ink-400">
              {queueItems.length} posts · {Math.ceil(queueItems.length / postsPerDay)} days estimated · {startHour}:00–{endHour}:00 window
            </p>
            <p className="text-xs text-jade-500 mt-1">⚡ First post will execute immediately when bot starts</p>
          </div>

          {error && <p className="text-sm text-flame-400 bg-flame-500/10 border border-flame-500/20 rounded-lg px-3 py-2 mb-4">{error}</p>}

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(2)}>← Back</button>
            <button className="btn-primary" disabled={launching} onClick={launch}>
              {launching ? <><Loader2 size={14} className="animate-spin"/> Launching…</> : '🚀 Launch Campaign'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
