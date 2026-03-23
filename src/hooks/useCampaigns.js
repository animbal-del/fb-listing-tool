import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('campaigns')
        .select(`
          *,
          post_queue (
            id,
            status,
            scheduled_at,
            posted_at,
            error_log,
            assigned_bot_id,
            claimed_at,
            properties ( id, title, locality, photos ),
            groups ( id, name, fb_url )
          )
        `)
        .order('created_at', { ascending: false })

      if (error) {
        console.error('useCampaigns fetch error:', error)
        setCampaigns([])
        return
      }

      const botIds = [
        ...new Set(
          (data || [])
            .flatMap(c => c.post_queue || [])
            .map(q => q.assigned_bot_id)
            .filter(Boolean)
        ),
      ]

      let botNameMap = new Map()

      if (botIds.length > 0) {
        const { data: bots, error: botError } = await supabase
          .from('bot_accounts')
          .select('id, name')
          .in('id', botIds)

        if (botError) {
          console.error('useCampaigns bot lookup error:', botError)
        } else {
          botNameMap = new Map((bots || []).map(bot => [bot.id, bot.name]))
        }
      }

      const enriched = (data || []).map(campaign => ({
        ...campaign,
        post_queue: (campaign.post_queue || []).map(item => ({
          ...item,
          assigned_bot_name: item.assigned_bot_id
            ? botNameMap.get(item.assigned_bot_id) || null
            : null,
        })),
      }))

      setCampaigns(enriched)
    } catch (e) {
      console.error('useCampaigns unexpected error:', e)
      setCampaigns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
  }, [fetch])

  const createCampaign = async ({ notes, postsPerDay, startHour, endHour, jitter, queueItems }) => {
    const { data: campaign, error: ce } = await supabase
      .from('campaigns')
      .insert([{
        notes,
        total_posts: queueItems.length,
        posts_per_day_limit: postsPerDay,
        posting_start_hour: startHour,
        posting_end_hour: endHour,
        jitter_enabled: jitter,
        status: 'active',
      }])
      .select()
      .single()

    if (ce) throw new Error(ce.message)

    const MIN_GAP = 8
    const MAX_GAP = 22
    const scheduledItems = []
    let cursor = new Date()

    const h = cursor.getHours()
    if (h < startHour) cursor.setHours(startHour, 0, 0, 0)
    if (h >= endHour) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(startHour, 0, 0, 0)
    }

    let postsToday = 0

    for (let i = 0; i < queueItems.length; i++) {
      scheduledItems.push({
        campaign_id: campaign.id,
        property_id: queueItems[i].property_id,
        group_id: queueItems[i].group_id,
        scheduled_at: cursor.toISOString(),
        duplicate_warned: queueItems[i].duplicate_warned || false,
        status: 'pending',
      })

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
    setCampaigns(prev => prev.map(c => (c.id === id ? { ...c, status } : c)))
  }

  return { campaigns, loading, refetch: fetch, createCampaign, updateStatus }
}