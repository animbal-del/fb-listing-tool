import { useState } from 'react'
import { uploadToStorage, deleteFromStorage } from '../lib/storage'
import { dennerSupabase } from '../lib/dennerSupabase'
import { ImagePlus, X, Loader2 } from 'lucide-react'

const BHK_OPTIONS = ['1RK', '1BHK', '2BHK', '3BHK', '4BHK', '5BHK+']

const EMPTY = {
  description:   '',
  society_name:  '',
  bhk:           '',
  city:          '',
  rent:          '',
  deposit:       '',
  locality:      '',
  phone:         '',
  whatsapp_link: '',
  photos:        [],   // [{url, storage_path, id?}]
  status:        'available',
}

function buildInitialPhotos(initial) {
  if (!initial?._media?.length) return []
  return initial._media.map(m => ({
    id:           m.id,
    url:          m.public_url,
    storage_path: m.storage_path,
    media_type:   m.media_type || 'image',
  }))
}

export default function PropertyForm({ initial = {}, onSave, onCancel }) {
  const initPhotos = buildInitialPhotos(initial)

  const [form, setForm] = useState({
    ...EMPTY,
    ...initial,
    photos: initPhotos,
  })
  const [uploading, setUploading] = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handlePhotos = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return

    setUploading(true)
    try {
      const uploaded = []
      for (const file of files) {
        const result = await uploadToStorage(file)
        uploaded.push(result)
      }
      setForm(f => ({ ...f, photos: [...f.photos, ...uploaded] }))
    } catch (err) {
      setError('Photo upload failed: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const removePhoto = async (photo) => {
    try {
      if (photo.id) {
        await dennerSupabase.from('inventory_flat_media').delete().eq('id', photo.id)
      }
      await deleteFromStorage(photo.storage_path)
    } catch {
      // proceed even if cleanup fails
    }
    setForm(f => ({ ...f, photos: f.photos.filter(p => p.storage_path !== photo.storage_path) }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const payload = {
        ...form,
        rent:    form.rent    ? parseInt(form.rent)    : null,
        deposit: form.deposit ? parseInt(form.deposit) : null,
      }
      await onSave(payload)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-3xl mx-auto w-full">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <label className="label">Society / Building Name *</label>
          <input
            className="input"
            placeholder="e.g. Shree Apartments"
            required
            value={form.society_name}
            onChange={e => set('society_name', e.target.value)}
          />
        </div>
        <div>
          <label className="label">BHK *</label>
          <input
            className="input"
            list="bhk-suggestions"
            placeholder="e.g. 2BHK"
            required
            value={form.bhk}
            onChange={e => set('bhk', e.target.value)}
          />
          <datalist id="bhk-suggestions">
            {BHK_OPTIONS.map(o => <option key={o} value={o} />)}
          </datalist>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">City *</label>
          <input
            className="input"
            placeholder="e.g. Mumbai"
            required
            value={form.city}
            onChange={e => set('city', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Locality *</label>
          <input
            className="input"
            placeholder="e.g. Bandra West"
            required
            value={form.locality}
            onChange={e => set('locality', e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label">Description / Post Body</label>
        <textarea
          className="input resize-none"
          rows={5}
          placeholder="Raw description from inventory intake (raw_description). Leave blank if not available."
          value={form.description}
          onChange={e => set('description', e.target.value)}
        />
        <p className="text-xs text-ink-500 mt-1">{form.description.length} chars</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Rent (₹/mo)</label>
          <input
            className="input"
            type="number"
            placeholder="45000"
            value={form.rent}
            onChange={e => set('rent', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Deposit (₹)</label>
          <input
            className="input"
            type="number"
            placeholder="90000"
            value={form.deposit}
            onChange={e => set('deposit', e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Owner / Source Number</label>
          <input
            className="input"
            placeholder="+91 98201 00000"
            value={form.phone}
            onChange={e => set('phone', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Handler WhatsApp Number</label>
          <input
            className="input"
            placeholder="+919820100000"
            value={form.whatsapp_link}
            onChange={e => set('whatsapp_link', e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label">Status</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {['available', 'rented'].map(s => (
            <button
              key={s}
              type="button"
              onClick={() => set('status', s)}
              className={`w-full py-2 rounded-lg text-sm font-medium border transition-colors ${
                form.status === s
                  ? s === 'available'
                    ? 'bg-jade-500/20 border-jade-500/40 text-jade-400'
                    : 'bg-flame-500/20 border-flame-500/40 text-flame-400'
                  : 'bg-ink-900 border-ink-700 text-ink-400 hover:border-ink-500'
              }`}
            >
              {s === 'available' ? '✓ Available' : '✗ Rented Out'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Photos & Videos</label>
        <div className="flex flex-wrap gap-3 mb-3">
          {form.photos.map(photo => (
            <div
              key={photo.storage_path}
              className="relative w-20 h-20 rounded-lg overflow-hidden border border-ink-700 group"
            >
              {photo.media_type === 'video' ? (
                <video
                  src={photo.url}
                  className="w-full h-full object-cover"
                  muted
                  playsInline
                />
              ) : (
                <img src={photo.url} alt="" className="w-full h-full object-cover" />
              )}
              {photo.media_type === 'video' && (
                <span className="absolute bottom-1 left-1 bg-ink-900/80 text-ink-300 text-[9px] px-1 rounded">
                  VIDEO
                </span>
              )}
              <button
                type="button"
                onClick={() => removePhoto(photo)}
                className="absolute inset-0 bg-ink-900/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
                <X size={16} className="text-white" />
              </button>
            </div>
          ))}

          <label
            className={`w-20 h-20 rounded-lg border-2 border-dashed border-ink-700 flex flex-col items-center justify-center cursor-pointer hover:border-ink-500 transition-colors ${
              uploading ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {uploading ? (
              <Loader2 size={18} className="text-ink-400 animate-spin" />
            ) : (
              <ImagePlus size={18} className="text-ink-400" />
            )}
            <span className="text-xs text-ink-500 mt-1">
              {uploading ? 'Uploading' : 'Add'}
            </span>
            <input
              type="file"
              className="hidden"
              multiple
              accept="image/*,video/*"
              onChange={handlePhotos}
            />
          </label>
        </div>
        <p className="text-xs text-ink-600">Photos and videos are both supported.</p>
      </div>

      {error && (
        <p className="text-sm text-flame-400 bg-flame-500/10 border border-flame-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button
          type="submit"
          className="btn-primary flex-1 justify-center"
          disabled={saving || uploading}
        >
          {saving ? (
            <><Loader2 size={14} className="animate-spin" /> Saving…</>
          ) : (
            'Save Property'
          )}
        </button>
        <button type="button" className="btn-ghost justify-center" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
