import { dennerSupabase } from './dennerSupabase'

const BUCKET = import.meta.env.VITE_DENNER_STORAGE_BUCKET || 'flat-media'

const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'])

function detectMediaType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return VIDEO_EXTS.has(ext) ? 'video' : 'image'
}

export async function uploadToStorage(file) {
  const ext        = file.name.split('.').pop().toLowerCase()
  const media_type = detectMediaType(file.name)
  const path       = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const { error } = await dennerSupabase.storage.from(BUCKET).upload(path, file, { upsert: false })
  if (error) throw error

  const { data } = dennerSupabase.storage.from(BUCKET).getPublicUrl(path)
  return { storage_path: path, url: data.publicUrl, media_type }
}

export async function deleteFromStorage(storagePath) {
  if (!storagePath) return
  await dennerSupabase.storage.from(BUCKET).remove([storagePath])
}
