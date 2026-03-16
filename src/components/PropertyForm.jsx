import { useState } from 'react'
import { uploadPhotos, deletePhoto } from '../lib/storage'
import { ImagePlus, X, Loader2 } from 'lucide-react'

const EMPTY = {
  title: '',
  description: '',
  rent: '',
  deposit: '',
  locality: '',
  phone: '',
  whatsapp_link: '',
  photos: [],
  status: 'available'
}

export default function PropertyForm({ initial = {}, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial })
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const handlePhotos = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return

    setUploading(true)
    try {
      const tempId = initial.id || `temp-${Date.now()}`
      const urls = await uploadPhotos(files, tempId)
      setForm((f) => ({ ...f, photos: [...(f.photos || []), ...urls] }))
    } catch (err) {
      setError('Photo upload failed: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const removePhoto = async (url) => {
    try {
      await deletePhoto(url)
      setForm((f) => ({ ...f, photos: f.photos.filter((p) => p !== url) }))
    } catch {
      setForm((f) => ({ ...f, photos: f.photos.filter((p) => p !== url) }))
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSaving(true)

    try {
      const payload = {
        ...form,
        rent: form.rent ? parseInt(form.rent) : null,
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
      <div>
        <label className="label">Listing Title *</label>
        <input
          className="input"
          placeholder="e.g. 2BHK Bandra West — Furnished"
          required
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
        />
      </div>

      <div>
        <label className="label">Description / Post Body *</label>
        <textarea
          className="input resize-none"
          rows={5}
          required
          placeholder="Full listing text that will be posted to Facebook groups…"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
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
            onChange={(e) => set('rent', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Deposit (₹)</label>
          <input
            className="input"
            type="number"
            placeholder="90000"
            value={form.deposit}
            onChange={(e) => set('deposit', e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label">Locality</label>
        <input
          className="input"
          placeholder="e.g. Bandra West"
          value={form.locality}
          onChange={(e) => set('locality', e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Phone</label>
          <input
            className="input"
            placeholder="+91 98201 00000"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </div>
        <div>
          <label className="label">WhatsApp Link</label>
          <input
            className="input"
            placeholder="https://wa.me/91982010000"
            value={form.whatsapp_link}
            onChange={(e) => set('whatsapp_link', e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label">Status</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {['available', 'rented'].map((s) => (
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
        <label className="label">Photos</label>
        <div className="flex flex-wrap gap-3 mb-3">
          {form.photos.map((url) => (
            <div
              key={url}
              className="relative w-20 h-20 rounded-lg overflow-hidden border border-ink-700 group"
            >
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(url)}
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
              accept="image/*"
              onChange={handlePhotos}
            />
          </label>
        </div>
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
            <>
              <Loader2 size={14} className="animate-spin" /> Saving…
            </>
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