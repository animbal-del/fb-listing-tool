import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

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

  const bulkImport = async (rows) => {
    const { data, error: err } = await supabase.from('groups').insert(rows).select()
    if (err) throw new Error(err.message)
    setGroups(prev => [...prev, ...data].sort((a, b) => a.name.localeCompare(b.name)))
    return data
  }

  return { groups, loading, error, refetch: fetch, create, update, remove, toggleActive, bulkImport }
}
