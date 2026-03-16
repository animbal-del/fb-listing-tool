import { useMemo, useState } from 'react'
import { useProperties } from '../hooks/useProperties'
import Modal from '../components/Modal'
import PropertyForm from '../components/PropertyForm'
import StatusBadge from '../components/StatusBadge'
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Home,
  ImageOff
} from 'lucide-react'

export default function PropertiesPage() {
  const { properties, loading, create, update, remove, toggleStatus } = useProperties()

  const [search, setSearch] = useState('')
  const [filterStatus, setFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirm] = useState(null)

  const filtered = useMemo(() => {
    return properties.filter((p) => {
      const title = p.title?.toLowerCase() || ''
      const locality = p.locality?.toLowerCase() || ''
      const query = search.toLowerCase()

      const matchSearch = !search || title.includes(query) || locality.includes(query)
      const matchStatus = filterStatus === 'all' || p.status === filterStatus

      return matchSearch && matchStatus
    })
  }, [properties, search, filterStatus])

  const availableCount = properties.filter((p) => p.status === 'available').length
  const rentedCount = properties.filter((p) => p.status === 'rented').length

  const closeAddModal = () => {
    setShowForm(false)
  }

  const closeEditModal = () => {
    setEditing(null)
  }

  const handleOpenAdd = () => {
    setEditing(null)
    setShowForm(true)
  }

  const handleEdit = (property) => {
    setShowForm(false)
    setEditing(property)
  }

  const handleSave = async (payload) => {
    if (editing) {
      await update(editing.id, payload)
      setEditing(null)
      return
    }

    await create(payload)
    setShowForm(false)
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    await remove(confirmDelete.id)
    setConfirm(null)
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 fade-up">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">Properties</h1>
          <p className="text-sm text-ink-400 mt-0.5">
            {availableCount} available · {rentedCount} rented
          </p>
        </div>

        <button className="btn-primary w-full md:w-auto justify-center" onClick={handleOpenAdd}>
          <Plus size={16} />
          Add Property
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 mb-6">
        <div className="relative flex-1 lg:max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
          />
          <input
            className="input pl-9"
            placeholder="Search by title or locality…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {['all', 'available', 'rented'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                filterStatus === s
                  ? 'bg-ink-700 border-ink-500 text-ink-100'
                  : 'bg-transparent border-ink-700 text-ink-400 hover:border-ink-500'
              }`}
            >
              {s === 'all' ? 'All' : s === 'available' ? 'Available' : 'Rented Out'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card h-64 animate-pulse bg-ink-800" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-10 sm:p-12 flex flex-col items-center justify-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-ink-700 flex items-center justify-center mb-4">
            <Home size={24} className="text-ink-400" />
          </div>
          <p className="text-ink-300 font-medium mb-1">No properties found</p>
          <p className="text-ink-500 text-sm">Add your first property to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <div
              key={p.id}
              className="card overflow-hidden hover:border-ink-600 transition-colors group"
            >
              <div className="h-36 bg-ink-700 relative overflow-hidden">
                {p.photos?.[0] ? (
                  <img
                    src={p.photos[0]}
                    alt={p.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageOff size={24} className="text-ink-600" />
                  </div>
                )}

                {p.photos?.length > 1 && (
                  <span className="absolute bottom-2 right-2 bg-ink-900/80 text-ink-300 text-xs px-2 py-0.5 rounded-full">
                    +{p.photos.length - 1}
                  </span>
                )}
              </div>

              <div className="p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-ink-100 leading-snug line-clamp-2">
                    {p.title}
                  </h3>
                  <StatusBadge status={p.status} />
                </div>

                {p.locality && (
                  <p className="text-xs text-ink-400 mb-2">📍 {p.locality}</p>
                )}

                <div className="flex flex-wrap gap-2 text-xs text-ink-300 mb-3">
                  {p.rent && <span>₹{Number(p.rent).toLocaleString()}/mo</span>}
                  {p.deposit && <span>• Dep ₹{Number(p.deposit).toLocaleString()}</span>}
                </div>

                <div className="flex items-center gap-2 pt-3 border-t border-ink-700">
                  <button
                    onClick={() => toggleStatus(p.id, p.status)}
                    className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-200 transition-colors"
                  >
                    {p.status === 'available' ? (
                      <>
                        <ToggleRight size={14} className="text-jade-400" />
                        Mark Rented
                      </>
                    ) : (
                      <>
                        <ToggleLeft size={14} className="text-flame-400" />
                        Mark Available
                      </>
                    )}
                  </button>

                  <div className="flex-1" />

                  <button
                    onClick={() => handleEdit(p)}
                    className="p-1.5 rounded hover:bg-ink-700 text-ink-400 hover:text-ink-200 transition-colors"
                  >
                    <Pencil size={13} />
                  </button>

                  <button
                    onClick={() => setConfirm(p)}
                    className="p-1.5 rounded hover:bg-flame-500/10 text-ink-400 hover:text-flame-400 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showForm} title="Add Property" onClose={closeAddModal} size="lg">
        
          <PropertyForm onSave={handleSave} onCancel={closeAddModal} />
        
      </Modal>

      <Modal open={!!editing} title="Edit Property" onClose={closeEditModal} size="lg">
        
          <PropertyForm initial={editing} onSave={handleSave} onCancel={closeEditModal} />
        
      </Modal>

      <Modal open={!!confirmDelete} title="Delete Property" onClose={() => setConfirm(null)} size="sm">
        <div className="p-6">
          <p className="text-ink-300 text-sm mb-1">Are you sure you want to delete</p>
          <p className="text-ink-100 font-semibold mb-4">"{confirmDelete?.title}"?</p>
          <p className="text-ink-500 text-xs mb-6">This cannot be undone.</p>

          <div className="flex gap-3">
            <button
              onClick={handleDelete}
              className="btn-primary bg-red-600 hover:bg-red-500 flex-1 justify-center"
            >
              Delete
            </button>
            <button onClick={() => setConfirm(null)} className="btn-ghost">
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}