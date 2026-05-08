import { useState, useEffect, useCallback } from 'react'
import { dennerSupabase } from '../lib/dennerSupabase'
import { deleteFromStorage } from '../lib/storage'

function normalizeFlat(flat) {
  const allMedia  = (flat.inventory_flat_media || []).sort((a, b) => a.sort_order - b.sort_order)
  const images    = allMedia.filter(m => m.media_type === 'image')
  const videos    = allMedia.filter(m => m.media_type === 'video')
  const intake    = (flat.inventory_flat_intake || [])[0] || null

  const ownerNumber   = flat.owner_phone || flat.source_phone || ''
  const handlerNumber = flat.handler_whatsapp_number || ''

  return {
    id:           flat.id,
    // society_name is used as the display title everywhere (campaign builder, dashboard, cards)
    title:        flat.society_name || flat.title || '',
    society_name: flat.society_name || '',
    // description comes ONLY from intake raw_description — never falls back to inventory_flats.description
    description:  intake?.raw_description || '',
    rent:         flat.monthly_rent,
    deposit:      flat.deposit,
    locality:     flat.locality || '',
    city:         flat.city || '',
    bhk:          flat.bhk || '',

    owner_number:   ownerNumber,
    handler_number: handlerNumber,
    // Aliases for PropertyForm field binding and bot {phone}/{whatsapp_link} template vars
    phone:         ownerNumber,
    whatsapp_link: handlerNumber,

    status:     flat.business_status || 'available',
    photos:     images.map(m => m.public_url),
    videos:     videos.map(m => m.public_url),
    created_at: flat.created_at,
    updated_at: flat.updated_at,
    _media:     allMedia,   // all media (images + videos) for PropertyForm
    _intake_id: intake?.id || null,
  }
}

export function useProperties() {
  const [properties, setProperties] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await dennerSupabase
        .from('inventory_flats')
        .select(`
          id, title, description, monthly_rent, deposit, locality, city, bhk, society_name,
          owner_phone, source_phone, handler_whatsapp_number, business_status,
          created_at, updated_at,
          inventory_flat_media ( id, storage_path, public_url, sort_order, media_type, is_cover ),
          inventory_flat_intake!inventory_flat_intake_linked_flat_id_fkey ( id, raw_description )
        `)
        .order('created_at', { ascending: false })

      if (err) {
        console.error('useProperties fetch error:', err)
        setError(err.message)
        setProperties([])
      } else {
        setProperties((data ?? []).map(normalizeFlat))
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
    const { photos = [], description, ...fields } = payload

    const { data: flat, error: flatErr } = await dennerSupabase
      .from('inventory_flats')
      .insert([{
        title:                   fields.society_name,
        society_name:            fields.society_name,
        bhk:                     fields.bhk,
        city:                    fields.city,
        locality:                fields.locality,
        monthly_rent:            fields.rent   ? parseInt(fields.rent)    : 0,
        deposit:                 fields.deposit ? parseInt(fields.deposit) : 0,
        owner_phone:             fields.phone          || null,
        handler_whatsapp_number: fields.whatsapp_link  || null,
        business_status:         fields.status         || 'available',
        source_channel:          'admin_manual',
        source_type:             'admin',
        listing_status:          'draft',
        review_status:           'pending_review',
        visibility_status:       'private',
      }])
      .select('id')
      .single()

    if (flatErr) throw new Error(flatErr.message)

    const flatId = flat.id

    if (description) {
      const { error: intakeErr } = await dennerSupabase
        .from('inventory_flat_intake')
        .insert([{
          linked_flat_id: flatId,
          raw_description: description,
          intake_mode:   'quick_paste',
          intake_status: 'pending',
        }])
      if (intakeErr) console.error('intake insert error:', intakeErr.message)
    }

    if (photos.length) {
      const mediaInserts = photos.map((p, i) => ({
        flat_id:      flatId,
        media_type:   p.media_type || 'image',
        storage_path: p.storage_path,
        public_url:   p.url,
        sort_order:   i,
        is_cover:     i === 0 && p.media_type !== 'video',
      }))
      const { error: mediaErr } = await dennerSupabase.from('inventory_flat_media').insert(mediaInserts)
      if (mediaErr) console.error('media insert error:', mediaErr.message)
    }

    await fetch()
    return properties.find(p => p.id === flatId) || { id: flatId }
  }

  const update = async (id, payload) => {
    const { photos = [], description, _media: _ignored, _intake_id, ...fields } = payload

    const { error: flatErr } = await dennerSupabase
      .from('inventory_flats')
      .update({
        title:                   fields.society_name,
        society_name:            fields.society_name,
        bhk:                     fields.bhk,
        city:                    fields.city,
        locality:                fields.locality,
        monthly_rent:            fields.rent    ? parseInt(fields.rent)    : 0,
        deposit:                 fields.deposit ? parseInt(fields.deposit) : 0,
        owner_phone:             fields.phone         || null,
        handler_whatsapp_number: fields.whatsapp_link || null,
        business_status:         fields.status        || 'available',
        updated_at:              new Date().toISOString(),
      })
      .eq('id', id)

    if (flatErr) throw new Error(flatErr.message)

    if (_intake_id) {
      await dennerSupabase
        .from('inventory_flat_intake')
        .update({ raw_description: description ?? '' })
        .eq('id', _intake_id)
    } else if (description) {
      await dennerSupabase
        .from('inventory_flat_intake')
        .insert([{
          linked_flat_id:  id,
          raw_description: description,
          intake_mode:     'quick_paste',
          intake_status:   'pending',
        }])
    }

    // Insert any newly uploaded photos (those without an id)
    const newPhotos = photos.filter(p => !p.id)
    if (newPhotos.length) {
      const { data: existing } = await dennerSupabase
        .from('inventory_flat_media')
        .select('sort_order')
        .eq('flat_id', id)
        .order('sort_order', { ascending: false })
        .limit(1)

      const baseOrder = existing?.[0]?.sort_order ?? -1

      const inserts = newPhotos.map((p, i) => ({
        flat_id:      id,
        media_type:   p.media_type || 'image',
        storage_path: p.storage_path,
        public_url:   p.url,
        sort_order:   baseOrder + 1 + i,
        is_cover:     false,
      }))
      await dennerSupabase.from('inventory_flat_media').insert(inserts)
    }

    await fetch()
  }

  const remove = async (id) => {
    const target = properties.find(p => p.id === id)

    if (target?._media?.length) {
      await dennerSupabase.from('inventory_flat_media').delete().eq('flat_id', id)
      for (const m of target._media) {
        await deleteFromStorage(m.storage_path)
      }
    }

    await dennerSupabase.from('inventory_flat_intake').delete().eq('linked_flat_id', id)

    const { error: err } = await dennerSupabase.from('inventory_flats').delete().eq('id', id)
    if (err) throw new Error(err.message)

    setProperties(prev => prev.filter(p => p.id !== id))
  }

  const toggleStatus = async (id, currentStatus) => {
    return update(id, {
      ...properties.find(p => p.id === id),
      status: currentStatus === 'available' ? 'rented' : 'available',
    })
  }

  return { properties, loading, error, refetch: fetch, create, update, remove, toggleStatus }
}
