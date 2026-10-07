import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

// Saved text messages that can be posted to groups as a message campaign
export function useMessages() {
  const [messages, setMessages] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('messages')
        .select('*')
        .order('updated_at', { ascending: false })
      if (err) {
        console.error('useMessages fetch error:', err)
        setError(err.message)
        setMessages([])
      } else {
        setMessages(data ?? [])
      }
    } catch (e) {
      console.error('useMessages unexpected error:', e)
      setError(e.message)
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const create = async ({ title, body }) => {
    const { data, error: err } = await supabase
      .from('messages').insert([{ title, body }]).select().single()
    if (err) throw new Error(err.message)
    setMessages(prev => [data, ...prev])
    return data
  }

  const update = async (id, { title, body }) => {
    const { data, error: err } = await supabase
      .from('messages')
      .update({ title, body, updated_at: new Date().toISOString() })
      .eq('id', id).select().single()
    if (err) throw new Error(err.message)
    setMessages(prev => [data, ...prev.filter(m => m.id !== id)])
    return data
  }

  const remove = async (id) => {
    const { error: err } = await supabase.from('messages').delete().eq('id', id)
    if (err) throw new Error(err.message)
    setMessages(prev => prev.filter(m => m.id !== id))
  }

  return { messages, loading, error, refetch: fetch, create, update, remove }
}
