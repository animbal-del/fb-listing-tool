import { useState, useMemo } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useGroups }     from '../hooks/useGroups'
import { useCampaigns }  from '../hooks/useCampaigns'
import { useMessages }   from '../hooks/useMessages'
import { messageTextsForGroups, canTweak, hasLink } from '../lib/messageTweaks'
import { supabase }      from '../lib/supabase'
import { DnrTag, matchesFlatSearch } from '../lib/flatCode'
import { useNavigate, useLocation }   from 'react-router-dom'
import {
  CheckSquare, Square, AlertTriangle, ChevronRight,
  Loader2, Search, MapPin, Home, MessageSquare, Plus, ChevronDown, ChevronUp
} from 'lucide-react'

const STEPS = {
  listing: ['Select Listings', 'Select Groups', 'Review Queue', 'Settings & Launch'],
  message: ['Select Message', 'Select Groups', 'Review Queue', 'Settings & Launch'],
}

export default function CampaignPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { properties } = useProperties()
  const { groups }     = useGroups()
  const { createCampaign } = useCampaigns()
  const { messages, loading: messagesLoading } = useMessages()
  const duplicateCampaign = location.state?.duplicateCampaign || null
  const initialMessageId  = duplicateCampaign?.messageId || location.state?.messageId || null
  const initialMode       = duplicateCampaign?.campaignType || (initialMessageId ? 'message' : 'listing')

  const [mode, setMode]                       = useState(initialMode)
  const [selectedMessageId, setSelectedMessageId] = useState(initialMessageId)
  const [messageSearch, setMessageSearch]     = useState('')
  const [expandedRow, setExpandedRow]         = useState(null)

  const [step, setStep]             = useState(duplicateCampaign ? 2 : 0)
  const [selectedProps, setSelectedProps]   = useState(() => new Set(duplicateCampaign?.queueItems?.map(item => item.property_id).filter(Boolean) || []))
  const [selectedGroups, setSelectedGroups] = useState(() => new Set(duplicateCampaign?.queueItems?.map(item => item.group_id) || []))
  const [dupWarnings, setDupWarnings]       = useState(() => {
    const map = {}
    for (const item of duplicateCampaign?.queueItems || []) {
      if (item.duplicate_warned) map[`${item.property_id}-${item.group_id}`] = true
    }
    return map
  })

  // Filters
  const [propSearch,     setPropSearch]     = useState('')
  const [propLocality,   setPropLocality]   = useState('all')
  const [groupSearch,    setGroupSearch]    = useState('')
  const [groupLocality,  setGroupLocality]  = useState('all')

  // Settings
  const [notes,       setNotes]       = useState(duplicateCampaign?.notes || '')
  const [postsPerDay, setPostsPerDay] = useState(duplicateCampaign?.postsPerDay ?? 18)
  const [startHour,   setStartHour]   = useState(duplicateCampaign?.startHour ?? 9)
  const [endHour,     setEndHour]     = useState(duplicateCampaign?.endHour ?? 20)
  const [jitter,      setJitter]      = useState(duplicateCampaign?.jitter ?? initialMode === 'message')
  const [launching,   setLaunching]   = useState(false)
  const [error,       setError]       = useState('')

  const availableProps = properties.filter(p => p.status === 'available')
  const activeGroups   = groups.filter(g => g.active)

  // Locality lists
  const propLocalities  = ['all', ...new Set(availableProps.map(p => p.locality).filter(Boolean))]
  const groupLocalities = ['all', ...new Set(activeGroups.map(g => g.locality_tag).filter(Boolean))]

  // Filtered lists
  const filteredProps = availableProps.filter(p => {
    const matchSearch   = matchesFlatSearch(p, propSearch)
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

  const switchMode = (next) => {
    if (next === mode) return
    setMode(next)
    setJitter(next === 'message') // group variations on by default for messages
    setExpandedRow(null)
  }

  const selectedMessage  = messages.find(m => m.id === selectedMessageId) || null
  const filteredMessages = messages.filter(m => {
    const q = messageSearch.trim().toLowerCase()
    return !q || m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q)
  })

  const queueItems = useMemo(() => {
    if (mode === 'message') {
      if (!selectedMessage) return []
      // Stable group order (by name) so each group's variation is predictable
      const gids  = groups.filter(g => selectedGroups.has(g.id)).map(g => g.id)
      const texts = messageTextsForGroups(selectedMessage.body, gids.length, jitter)
      return gids.map((gid, i) => ({
        property_id: null, group_id: gid, message_text: texts[i], variation: i, duplicate_warned: false,
      }))
    }
    const items = []
    for (const pid of selectedProps) {
      for (const gid of selectedGroups) {
        items.push({ property_id: pid, group_id: gid, duplicate_warned: !!dupWarnings[`${pid}-${gid}`] })
      }
    }
    return items
  }, [mode, selectedMessage, groups, jitter, selectedProps, selectedGroups, dupWarnings])

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
    if (next === 2 && mode === 'listing') await checkDuplicates()
    setStep(next)
  }

  const launch = async () => {
    setError(''); setLaunching(true)
    try {
      await createCampaign({
        notes: notes.trim() || (mode === 'message' ? selectedMessage?.title || '' : ''),
        postsPerDay, startHour, endHour, jitter, queueItems,
        campaignType: mode,
        messageId:    mode === 'message' ? selectedMessage?.id || null : null,
        messageTitle: mode === 'message' ? selectedMessage?.title || null : null,
      })
      navigate('/dashboard')
    } catch (err) { setError(err.message) }
    finally { setLaunching(false) }
  }

  const propMap  = Object.fromEntries(properties.map(p => [p.id, p]))
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g]))
  const dupCount = Object.keys(dupWarnings).length

  return (
    <div className="px-8 pt-8 fade-up">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-ink-100">{duplicateCampaign ? 'Create Similar Campaign' : 'New Campaign'}</h1>
        <p className="text-sm text-ink-400 mt-0.5">
          {duplicateCampaign ? 'Review the copied listings, groups, and settings before launching a fresh campaign' : 'Select listings and groups to build a posting queue'}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {STEPS[mode].map((s, i) => (
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
            {i < STEPS[mode].length - 1 && <ChevronRight size={14} className="text-ink-600"/>}
          </div>
        ))}
      </div>

      {/* Campaign type */}
      {step === 0 && (
        <div className="flex items-center gap-1 p-1 mb-6 rounded-xl bg-ink-800 border border-ink-700 w-fit">
          {[['listing', Home, 'Listings'], ['message', MessageSquare, 'Message']].map(([key, Icon, label]) => (
            <button key={key} onClick={() => switchMode(key)}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                mode === key ? 'bg-flame-500 text-white' : 'text-ink-400 hover:text-ink-200'}`}>
              <Icon size={14}/> {label}
            </button>
          ))}
        </div>
      )}

      {/* ── STEP 0 — Select Message ── */}
      {step === 0 && mode === 'message' && (
        <div>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-sm text-ink-400">Pick the message to post</p>
            <button onClick={() => navigate('/messages')} className="text-sm text-flame-400 hover:text-flame-300 flex items-center gap-1">
              <Plus size={14}/> Write a new message
            </button>
          </div>

          <div className="relative mb-4 max-w-xs">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"/>
            <input className="input pl-9 text-sm" placeholder="Search messages…"
              value={messageSearch} onChange={e => setMessageSearch(e.target.value)}/>
          </div>

          {messagesLoading ? (
            <div className="card p-8 text-center text-ink-500 text-sm">Loading messages…</div>
          ) : messages.length === 0 ? (
            <div className="card p-8 text-center text-sm">
              <p className="text-ink-300">No saved messages yet.</p>
              <button onClick={() => navigate('/messages')} className="btn-primary mx-auto mt-3"><Plus size={15}/> Write a message</button>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="card p-8 text-center text-ink-500 text-sm">No messages match your search</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
              {filteredMessages.map(m => {
                const sel = selectedMessageId === m.id
                return (
                  <div key={m.id} onClick={() => setSelectedMessageId(m.id)}
                    className={`card p-4 cursor-pointer transition-all select-none ${sel ? 'border-flame-500/50 bg-flame-500/5' : 'hover:border-ink-600'}`}>
                    <div className="flex items-start gap-3">
                      <span className={`w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 ${sel ? 'border-flame-400 bg-flame-400' : 'border-ink-500'}`}/>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink-100 truncate">{m.title}</p>
                        <p className="text-xs text-ink-400 mt-1 whitespace-pre-wrap line-clamp-3">{m.body}</p>
                        {hasLink(m.body) && (
                          <p className="text-[11px] text-yellow-500 mt-1.5 flex items-center gap-1"><AlertTriangle size={11}/> Contains a link — some groups may hold it for approval</p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <StickyBar info={selectedMessage ? `💬 ${selectedMessage.title}` : 'No message selected'}>
            <button className="btn-primary" disabled={!selectedMessage} onClick={() => setStep(1)}>
              Next: Select Groups <ChevronRight size={15}/>
            </button>
          </StickyBar>
        </div>
      )}

      {/* ── STEP 0 — Select Listings ── */}
      {step === 0 && mode === 'listing' && (
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
            <input className="input pl-9 text-sm" placeholder="Search name or DNR number…"
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
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-medium text-ink-100 truncate">{p.title}</p>
                          <DnrTag code={p.code} className="shrink-0" />
                        </div>
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

          <StickyBar info={`${selectedProps.size} listing${selectedProps.size === 1 ? '' : 's'} selected`}>
            <button className="btn-primary" disabled={!selectedProps.size} onClick={() => setStep(1)}>
              Next: Select Groups <ChevronRight size={15}/>
            </button>
          </StickyBar>
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

          <StickyBar info={`${selectedGroups.size} group${selectedGroups.size === 1 ? '' : 's'} selected`}>
            <button className="btn-ghost" onClick={() => setStep(0)}>← Back</button>
            <button className="btn-primary" disabled={!selectedGroups.size} onClick={() => goToStep(2)}>
              Next: Review Queue <ChevronRight size={15}/>
            </button>
          </StickyBar>
        </div>
      )}

      {/* ── STEP 2 — Review Queue ── */}
      {step === 2 && (
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <p className="text-sm text-ink-400">
              {queueItems.length} posts queued
              {mode === 'message' && (jitter
                ? (selectedMessage && canTweak(selectedMessage.body) ? ' · each group gets a small variation — click a row to preview' : ' · no variations possible for this text')
                : ' · group variations off — every group gets the exact text')}
            </p>
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
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-400 uppercase tracking-wider">{mode === 'message' ? 'Message' : 'Property'}</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-400 uppercase tracking-wider">Group</th>
                  <th className="px-4 py-2.5"/>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/50">
                {mode === 'message' ? queueItems.map((item, i) => {
                  const open = expandedRow === i
                  const varied = item.message_text !== selectedMessage?.body
                  return [
                    <tr key={i} onClick={() => setExpandedRow(open ? null : i)} className="cursor-pointer hover:bg-ink-800/30">
                      <td className="px-4 py-2.5 text-ink-200">
                        💬 {selectedMessage?.title}
                        <span className="ml-2 text-xs text-ink-500">{varied ? `Variation ${item.variation + 1}` : 'Original'}</span>
                      </td>
                      <td className="px-4 py-2.5 text-ink-400">{groupMap[item.group_id]?.name}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-ink-500">
                        {open ? <span className="inline-flex items-center gap-1">Hide <ChevronUp size={12}/></span> : <span className="inline-flex items-center gap-1">Preview <ChevronDown size={12}/></span>}
                      </td>
                    </tr>,
                    open && (
                      <tr key={`${i}-text`} className="bg-ink-950/60">
                        <td colSpan={3} className="px-4 py-3">
                          <p className="text-xs text-ink-200 whitespace-pre-wrap leading-relaxed">{item.message_text}</p>
                        </td>
                      </tr>
                    ),
                  ]
                }) : queueItems.map((item, i) => {
                  const isDup = dupWarnings[`${item.property_id}-${item.group_id}`]
                  return (
                    <tr key={i} className={isDup ? 'bg-yellow-500/5' : ''}>
                      <td className="px-4 py-2.5 text-ink-200">
                        {propMap[item.property_id]?.title} <DnrTag code={propMap[item.property_id]?.code} className="ml-1" />
                      </td>
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
          <StickyBar info={`${queueItems.length} post${queueItems.length === 1 ? '' : 's'} queued`}>
            <button className="btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <button className="btn-primary" onClick={() => setStep(3)}>Next: Settings <ChevronRight size={15}/></button>
          </StickyBar>
        </div>
      )}

      {/* ── STEP 3 — Settings & Launch ── */}
      {step === 3 && (
        <div>
          <div className="max-w-lg">
          <div className="card p-6 space-y-5 mb-6">
            <div>
              <label className="label">Campaign Notes (optional)</label>
              <input className="input" placeholder={mode === 'message' ? `Defaults to "${selectedMessage?.title || 'message title'}"` : "e.g. March week 1 — Pune groups"}
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
                <p className="text-sm font-medium text-ink-200">{mode === 'message' ? 'Group Variations' : 'Text Jitter'}</p>
                <p className="text-xs text-ink-500">
                  {mode === 'message'
                    ? 'Vary emojis, greeting, closing line and bullets per group'
                    : 'Slightly vary each post to avoid detection'}
                </p>
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
            {duplicateCampaign ? (
              <p className="text-xs text-flame-400 mt-1">↺ Creating a fresh campaign from campaign {duplicateCampaign.sourceCampaignId?.slice(0, 8)}…</p>
            ) : (
              <p className="text-xs text-jade-500 mt-1">⚡ First post will execute immediately when bot starts</p>
            )}
          </div>

          {error && <p className="text-sm text-flame-400 bg-flame-500/10 border border-flame-500/20 rounded-lg px-3 py-2 mb-4">{error}</p>}
          </div>

          <StickyBar info={`${queueItems.length} post${queueItems.length === 1 ? '' : 's'} ready to launch`}>
            <button className="btn-ghost" onClick={() => setStep(2)}>← Back</button>
            <button className="btn-primary" disabled={launching} onClick={launch}>
              {launching ? <><Loader2 size={14} className="animate-spin"/> Launching…</> : duplicateCampaign ? '↺ Create Similar Campaign' : '🚀 Launch Campaign'}
            </button>
          </StickyBar>
        </div>
      )}
    </div>
  )
}

// Action bar pinned to the bottom of the scrolling page so Back/Next stay visible
function StickyBar({ info, children }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-8 mt-6 px-8 py-4 bg-ink-900/95 backdrop-blur border-t border-ink-800 flex items-center justify-between gap-3 flex-wrap">
      <p className="text-sm text-ink-400">{info}</p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}
