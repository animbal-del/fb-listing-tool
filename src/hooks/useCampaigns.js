import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState([])
  const [loading,   setLoading]   = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('campaigns')
        .select(`
          *,
          post_queue (
            id, status, scheduled_at, posted_at, error_log,
            properties ( id, title, locality, photos ),
            groups     ( id, name, fb_url )
          )
        `)
        .order('created_at', { ascending: false })
      if (error) console.error('useCampaigns fetch error:', error)
      setCampaigns(data ?? [])
    } catch (e) {
      console.error('useCampaigns unexpected error:', e)
      setCampaigns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const createCampaign = async ({ notes, postsPerDay, startHour, endHour, jitter, queueItems }) => {
    // 1. Insert campaign
    const { data: campaign, error: ce } = await supabase
      .from('campaigns')
      .insert([{
        notes,
        total_posts:        queueItems.length,
        posts_per_day_limit: postsPerDay,
        posting_start_hour: startHour,
        posting_end_hour:   endHour,
        jitter_enabled:     jitter,
        status:             'active',
      }])
      .select()
      .single()
    if (ce) throw new Error(ce.message)

    // 2. First item is scheduled NOW (no delay) so bot posts immediately
    //    All subsequent items get normal random gaps
    const MIN_GAP = 8, MAX_GAP = 22
    const scheduledItems = []
    let cursor = new Date() // first post = right now

    // Snap cursor into posting window if needed
    const h = cursor.getHours()
    if (h < startHour) cursor.setHours(startHour, 0, 0, 0)
    if (h >= endHour)  { cursor.setDate(cursor.getDate() + 1); cursor.setHours(startHour, 0, 0, 0) }

    let postsToday = 0
    for (let i = 0; i < queueItems.length; i++) {
      scheduledItems.push({
        campaign_id:      campaign.id,
        property_id:      queueItems[i].property_id,
        group_id:         queueItems[i].group_id,
        scheduled_at:     cursor.toISOString(),
        duplicate_warned: queueItems[i].duplicate_warned || false,
        status:           'pending',
      })

      // Advance cursor — first item already has no delay baked in (it's "now")
      postsToday++
      if (postsToday >= postsPerDay) {
        cursor = new Date(cursor)
        cursor.setDate(cursor.getDate() + 1)
        cursor.setHours(startHour, 0, 0, 0)
        postsToday = 0
      } else {
        const gapMins = MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP)
        cursor = new Date(cursor.getTime() + gapMins * 60 * 1000)
        if (cursor.getHours() >= endHour) {
          cursor.setDate(cursor.getDate() + 1)
          cursor.setHours(startHour, 0, 0, 0)
          postsToday = 0
        }
      }
    }

    // 3. Insert queue items in batches of 100
    for (let i = 0; i < scheduledItems.length; i += 100) {
      const batch = scheduledItems.slice(i, i + 100)
      const { error: qe } = await supabase.from('post_queue').insert(batch)
      if (qe) throw new Error(qe.message)
    }

    await fetch()
    return campaign
  }

  const updateStatus = async (id, status) => {
    const { error } = await supabase.from('campaigns').update({ status }).eq('id', id)
    if (error) throw new Error(error.message)
    setCampaigns(prev => prev.map(c => c.id === id ? { ...c, status } : c))
  }

  return { campaigns, loading, refetch: fetch, createCampaign, updateStatus }
}
