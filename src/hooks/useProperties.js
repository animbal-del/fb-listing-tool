import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useProperties() {
  const [properties, setProperties] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('properties')
        .select('*')
        .order('created_at', { ascending: false })
      if (err) {
        console.error('useProperties fetch error:', err)
        setError(err.message)
        setProperties([])
      } else {
        setProperties(data ?? [])
      }
    } catch (e) {
      console.error('useProperties unexpected error:', e)
      setError(e.message)
      setProperties([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const create = async (payload) => {
    const { data, error: err } = await supabase
      .from('properties').insert([payload]).select().single()
    if (err) throw new Error(err.message)
    setProperties(prev => [data, ...prev])
    return data
  }

  const update = async (id, payload) => {
    const { data, error: err } = await supabase
      .from('properties').update(payload).eq('id', id).select().single()
    if (err) throw new Error(err.message)
    setProperties(prev => prev.map(p => p.id === id ? data : p))
    return data
  }

  const remove = async (id) => {
    const { error: err } = await supabase.from('properties').delete().eq('id', id)
    if (err) throw new Error(err.message)
    setProperties(prev => prev.filter(p => p.id !== id))
  }

  const toggleStatus = async (id, currentStatus) => {
    return update(id, { status: currentStatus === 'available' ? 'rented' : 'available' })
  }

  return { properties, loading, error, refetch: fetch, create, update, remove, toggleStatus }
}
