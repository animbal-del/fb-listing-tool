import { supabase } from './supabase'

const BUCKET = 'property-photos'

/**
 * Upload an array of File objects to Supabase Storage.
 * Returns array of public URLs.
 */
export async function uploadPhotos(files, propertyId) {
  const urls = []
  for (const file of files) {
    const ext  = file.name.split('.').pop()
    const path = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    urls.push(data.publicUrl)
  }
  return urls
}

/**
 * Delete a photo by its full public URL.
 */
export async function deletePhoto(publicUrl) {
  // Extract path from URL: everything after /property-photos/
  const marker = `/${BUCKET}/`
  const idx    = publicUrl.indexOf(marker)
  if (idx === -1) return
  const path = publicUrl.slice(idx + marker.length)
  await supabase.storage.from(BUCKET).remove([path])
}
