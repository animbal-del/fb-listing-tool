import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { dennerSupabase } from '../lib/dennerSupabase'

async function fetchPropertyMap(propertyIds) {
  if (!propertyIds.length) return new Map()

  const { data: flats, error } = await dennerSupabase
    .from('inventory_flats')
    .select(`
      id, flat_code, title, society_name, locality,
      inventory_flat_media ( public_url, sort_order, media_type, is_cover )
    `)
    .in('id', propertyIds)

  if (error) {
    console.error('fetchPropertyMap error:', error.message)
    return new Map()
  }

  const map = new Map()
  for (const flat of flats || []) {
    const photos = (flat.inventory_flat_media || [])
      .filter(m => m.media_type === 'image')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(m => m.public_url)

    map.set(flat.id, {
      id:       flat.id,
      title:    flat.society_name || flat.title || '',
      code:     flat.flat_code || '',
      locality: flat.locality,
      photos,
    })
  }
  return map
}

const ITEM_COLUMNS = `
  id,
  property_id,
  group_id,
  status,
  scheduled_at,
  posted_at,
  post_url,
  error_log,
  assigned_bot_id,
  claimed_at,
  duplicate_warned,
  message_text,
  groups ( id, name, fb_url )
`

// PostgREST returns at most 1000 rows per request
async function fetchAllRows(build) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

// Per-campaign post counts: { [campaignId]: { total, posted, pending, failed, skipped, processing } }
async function fetchCampaignStats() {
  let rows
  const { data, error } = await supabase.rpc('campaign_post_stats')
  if (!error) {
    rows = data || []
  } else {
    // campaign_post_stats() not installed yet (supabase_campaign_stats.sql) — count from statuses only
    const items = await fetchAllRows(() => supabase.from('post_queue').select('campaign_id, status').order('id'))
    rows = items.map(i => ({ campaign_id: i.campaign_id, status: i.status, n: 1 }))
  }

  const stats = {}
  for (const r of rows) {
    if (!stats[r.campaign_id]) stats[r.campaign_id] = { total: 0, posted: 0, pending: 0, failed: 0, skipped: 0, processing: 0 }
    const st = stats[r.campaign_id]
    const n = Number(r.n) || 0
    st.total += n
    st[r.status] = (st[r.status] || 0) + n
  }
  return stats
}

// Every post of one campaign, with property and bot names (for View Posts / Export / Create Similar)
export async function fetchCampaignItems(campaignId) {
  const items = await fetchAllRows(() =>
    supabase.from('post_queue').select(ITEM_COLUMNS).eq('campaign_id', campaignId).order('scheduled_at')
  )

  const propertyIds = [...new Set(items.map(q => q.property_id).filter(Boolean))]
  const botIds = [...new Set(items.map(q => q.assigned_bot_id).filter(Boolean))]

  const [propertyMap, botsRes] = await Promise.all([
    fetchPropertyMap(propertyIds),
    botIds.length
      ? supabase.from('bot_accounts').select('id, name').in('id', botIds)
      : Promise.resolve({ data: [] }),
  ])
  if (botsRes.error) console.error('fetchCampaignItems bot lookup error:', botsRes.error)
  const botNameMap = new Map((botsRes.data || []).map(bot => [bot.id, bot.name]))

  return items.map(item => ({
    ...item,
    properties:        propertyMap.get(item.property_id) || null,
    assigned_bot_name: item.assigned_bot_id ? botNameMap.get(item.assigned_bot_id) || null : null,
  }))
}

// autoload: false for pages that only create campaigns and don't list them
export function useCampaigns({ autoload = true } = {}) {
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading]     = useState(autoload)

  // Campaign rows plus post counts only — post details load per campaign on demand.
  // Background refreshes keep the current list on screen (no loading flash).
  const fetch = useCallback(async () => {
    try {
      const [{ data, error }, stats] = await Promise.all([
        supabase.from('campaigns').select('*').order('created_at', { ascending: false }),
        fetchCampaignStats(),
      ])

      if (error) {
        console.error('useCampaigns fetch error:', error)
        return
      }

      const empty = { total: 0, posted: 0, pending: 0, failed: 0, skipped: 0, processing: 0 }
      setCampaigns((data || []).map(c => ({ ...c, stats: stats[c.id] || empty })))
    } catch (e) {
      console.error('useCampaigns unexpected error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoload) fetch()
  }, [fetch, autoload])

  const createCampaign = async ({
    notes, postsPerDay, startHour, endHour, jitter, queueItems,
    campaignType = 'listing', messageId = null, messageTitle = null,
  }) => {
    const { data: campaign, error: ce } = await supabase
      .from('campaigns')
      .insert([{
        notes,
        total_posts:          queueItems.length,
        posts_per_day_limit:  postsPerDay,
        posting_start_hour:   startHour,
        posting_end_hour:     endHour,
        jitter_enabled:       jitter,
        status:               'active',
        campaign_type:        campaignType,
        message_id:           messageId,
        message_title:        messageTitle,
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
        campaign_id:      campaign.id,
        property_id:      queueItems[i].property_id ?? null,
        message_text:     queueItems[i].message_text ?? null,
        group_id:         queueItems[i].group_id,
        scheduled_at:     cursor.toISOString(),
        duplicate_warned: queueItems[i].duplicate_warned || false,
        status:           'pending',
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

    if (autoload) await fetch()
    return campaign
  }

  const updateStatus = async (id, status) => {
    const { error } = await supabase.from('campaigns').update({ status }).eq('id', id)
    if (error) throw new Error(error.message)
    setCampaigns(prev => prev.map(c => (c.id === id ? { ...c, status } : c)))
  }

  const deleteCampaign = async (campaignId) => {
    const { error: qError } = await supabase
      .from('post_queue')
      .delete()
      .eq('campaign_id', campaignId)

    if (qError) throw new Error(qError.message)

    const { error: cError } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', campaignId)

    if (cError) throw new Error(cError.message)

    await fetch()
  }

  const retryFailedPosts = async (campaignId) => {
    const now = new Date().toISOString()

    const { error } = await supabase
      .from('post_queue')
      .update({
        status:        'pending',
        error_log:     null,
        assigned_bot_id: null,
        claimed_at:    null,
        posted_at:     null,
        scheduled_at:  now,
      })
      .eq('campaign_id', campaignId)
      .eq('status', 'failed')

    if (error) throw new Error(error.message)

    await fetch()
  }

  return {
    campaigns,
    loading,
    refetch: fetch,
    createCampaign,
    updateStatus,
    retryFailedPosts,
    deleteCampaign,
  }
}
