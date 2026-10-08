import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function normalizeGroupUrl(url = '') {
  return String(url).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^(www|m|web)\./, '')
    .replace(/[?#].*$/, '').replace(/\/+$/, '')
}

export function useGroups() {
  const [groups,  setGroups]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('groups')
        .select('*')
        .order('name', { ascending: true })
      if (err) {
        console.error('useGroups fetch error:', err)
        setError(err.message)
        setGroups([])
      } else {
        setGroups(data ?? [])
      }
    } catch (e) {
      console.error('useGroups unexpected error:', e)
      setError(e.message)
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const create = async (payload) => {
    const { data, error: err } = await supabase
      .from('groups').insert([payload]).select().single()
    if (err) throw new Error(err.message)
    setGroups(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
    return data
  }

  const update = async (id, payload) => {
    const { data, error: err } = await supabase
      .from('groups').update(payload).eq('id', id).select().single()
    if (err) throw new Error(err.message)
    setGroups(prev => prev.map(g => g.id === id ? data : g))
    return data
  }

  const remove = async (id) => {
    const { error: err } = await supabase.from('groups').delete().eq('id', id)
    if (err) throw new Error(err.message)
    setGroups(prev => prev.filter(g => g.id !== id))
  }

  const toggleActive = async (id, current) => update(id, { active: !current })

  // Insert new groups; groups whose Facebook URL already exists get their
  // member count / locality updated instead of being duplicated.
  const bulkImport = async (rows) => {
    const byUrl = new Map(groups.map(g => [normalizeGroupUrl(g.fb_url), g]))
    const toInsert = []
    const toUpdate = []
    for (const row of rows) {
      const existing = byUrl.get(normalizeGroupUrl(row.fb_url))
      if (!existing) { toInsert.push(row); continue }
      const changes = {}
      if (row.member_count != null && row.member_count !== existing.member_count) changes.member_count = row.member_count
      if (row.locality_tag && row.locality_tag !== existing.locality_tag) changes.locality_tag = row.locality_tag
      if (Object.keys(changes).length) toUpdate.push({ id: existing.id, changes })
    }

    if (toInsert.length) {
      const { error: err } = await supabase.from('groups').insert(toInsert)
      if (err) throw new Error(err.message)
    }
    for (const { id, changes } of toUpdate) {
      const { error: err } = await supabase.from('groups').update(changes).eq('id', id)
      if (err) throw new Error(err.message)
    }

    await fetch()
    return { added: toInsert.length, updated: toUpdate.length, unchanged: rows.length - toInsert.length - toUpdate.length }
  }

  return { groups, loading, error, refetch: fetch, create, update, remove, toggleActive, bulkImport }
}
