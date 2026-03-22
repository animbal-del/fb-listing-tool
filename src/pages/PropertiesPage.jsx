import { useMemo, useRef, useState } from 'react'
import { useProperties } from '../hooks/useProperties'
import { supabase } from '../lib/supabase'
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
  ImageOff,
  Upload,
  FileSpreadsheet,
  Download,
  XCircle
} from 'lucide-react'

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }

  result.push(current.trim())
  return result.map(v => v.replace(/^"(.*)"$/, '$1').trim())
}

function parseCsv(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(line => line.trim().length > 0)

  if (lines.length < 2) {
    throw new Error('CSV must contain a header row and at least one data row')
  }

  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase())
  const rows = lines.slice(1).map(line => parseCsvLine(line))

  return rows.map((cols, rowIndex) => {
    const obj = {}
    headers.forEach((header, i) => {
      obj[header] = cols[i] ?? ''
    })
    obj.__row = rowIndex + 2
    return obj
  })
}

function normalizeImportedProperty(row) {
  const statusValue = (row.status || '').trim().toLowerCase()
  const status = statusValue === 'rented' ? 'rented' : 'available'

  return {
    title: (row.title || '').trim(),
    description: (row.description || '').trim() || null,
    rent: row.rent ? Number(row.rent) : null,
    deposit: row.deposit ? Number(row.deposit) : null,
    locality: (row.locality || '').trim() || null,
    phone: (row.phone || '').trim() || null,
    whatsapp_link: (row.whatsapp_link || '').trim() || null,
    status,
    photos: [],
  }
}

function downloadSampleCsv() {
  const csv = [
    'title,description,rent,deposit,locality,phone,whatsapp_link,status',
    '"1BHK Flat in Kharadi","Fully furnished near EON IT Park",25000,50000,"Kharadi","9156005618","https://wa.me/919156005618","available"',
    '"2BHK Flat in Wakad","Semi-furnished family flat",32000,70000,"Wakad","9156005618","https://wa.me/919156005618","available"',
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'properties_sample.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function ImportPreviewModal({
  open,
  rows,
  errors,
  importing,
  onClose,
  onImport,
}) {
  return (
    <Modal open={open} onClose={onClose} title="Import Properties CSV" size="xl">
      <div className="p-6 space-y-5">
        <div className="bg-ink-800 border border-ink-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileSpreadsheet size={16} className="text-flame-400" />
            <p className="text-sm font-medium text-ink-100">Import Summary</p>
          </div>
          <p className="text-sm text-ink-400">
            {rows.length} valid row{rows.length !== 1 ? 's' : ''} ready to import
          </p>
          {errors.length > 0 && (
            <p className="text-sm text-flame-400 mt-2">
              {errors.length} row{errors.length !== 1 ? 's' : ''} skipped due to validation issues
            </p>
          )}
        </div>

        {errors.length > 0 && (
          <div className="bg-flame-500/10 border border-flame-500/20 rounded-xl p-4">
            <p className="text-sm font-medium text-flame-300 mb-2">Skipped Rows</p>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {errors.map((err, idx) => (
                <p key={idx} className="text-xs text-flame-400">
                  Row {err.row}: {err.message}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="border border-ink-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ink-700 bg-ink-900">
            <p className="text-sm font-medium text-ink-100">Preview</p>
          </div>

          <div className="max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-ink-900 border-b border-ink-700">
                <tr>
                  <th className="text-left px-4 py-2 text-ink-500 font-medium">Title</th>
                  <th className="text-left px-4 py-2 text-ink-500 font-medium">Locality</th>
                  <th className="text-left px-4 py-2 text-ink-500 font-medium">Rent</th>
                  <th className="text-left px-4 py-2 text-ink-500 font-medium">Deposit</th>
                  <th className="text-left px-4 py-2 text-ink-500 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/30">
                {rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-ink-800/40">
                    <td className="px-4 py-2.5 text-ink-200">{row.title}</td>
                    <td className="px-4 py-2.5 text-ink-400">{row.locality || '—'}</td>
                    <td className="px-4 py-2.5 text-ink-400">
                      {row.rent ? `₹${Number(row.rent).toLocaleString()}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-ink-400">
                      {row.deposit ? `₹${Number(row.deposit).toLocaleString()}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-ink-400 capitalize">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-ink-800 border border-ink-700 rounded-xl p-4">
          <p className="text-xs text-ink-400">
            Photos are not imported via CSV in this version. Imported properties will be created without photos, and you can upload them later manually.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onImport}
            disabled={importing || rows.length === 0}
            className="btn-primary flex-1 justify-center disabled:opacity-50"
          >
            {importing ? 'Importing…' : `Import ${rows.length} Propert${rows.length === 1 ? 'y' : 'ies'}`}
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function PropertiesPage() {
  const { properties, loading, create, update, remove, toggleStatus } = useProperties()

  const [search, setSearch] = useState('')
  const [filterStatus, setFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirm] = useState(null)

  const [importRows, setImportRows] = useState([])
  const [importErrors, setImportErrors] = useState([])
  const [showImportModal, setShowImportModal] = useState(false)
  const [importing, setImporting] = useState(false)

  const fileInputRef = useRef(null)

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

  const openCsvPicker = () => {
    fileInputRef.current?.click()
  }

  const handleCsvSelected = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsedRows = parseCsv(text)

      const valid = []
      const invalid = []

      for (const row of parsedRows) {
        const normalized = normalizeImportedProperty(row)

        if (!normalized.title) {
          invalid.push({ row: row.__row, message: 'Missing required title' })
          continue
        }

        if (row.rent && Number.isNaN(Number(row.rent))) {
          invalid.push({ row: row.__row, message: 'Invalid rent value' })
          continue
        }

        if (row.deposit && Number.isNaN(Number(row.deposit))) {
          invalid.push({ row: row.__row, message: 'Invalid deposit value' })
          continue
        }

        valid.push(normalized)
      }

      setImportRows(valid)
      setImportErrors(invalid)
      setShowImportModal(true)
    } catch (err) {
      alert(err.message || 'Could not parse CSV file')
    } finally {
      event.target.value = ''
    }
  }

  const handleImport = async () => {
    if (importRows.length === 0) return

    setImporting(true)
    try {
      const { error } = await supabase.from('properties').insert(importRows)
      if (error) throw error

      setShowImportModal(false)
      setImportRows([])
      setImportErrors([])
      window.location.reload()
    } catch (err) {
      alert(err.message || 'Could not import properties')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 fade-up">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleCsvSelected}
      />

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">Properties</h1>
          <p className="text-sm text-ink-400 mt-0.5">
            {availableCount} available · {rentedCount} rented
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
          <button
            className="btn-ghost w-full md:w-auto justify-center"
            onClick={downloadSampleCsv}
          >
            <Download size={16} />
            Sample CSV
          </button>

          <button
            className="btn-ghost w-full md:w-auto justify-center"
            onClick={openCsvPicker}
          >
            <Upload size={16} />
            Import CSV
          </button>

          <button className="btn-primary w-full md:w-auto justify-center" onClick={handleOpenAdd}>
            <Plus size={16} />
            Add Property
          </button>
        </div>
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

      <div className="mb-5 bg-ink-800 border border-ink-700 rounded-xl p-4">
        <p className="text-sm text-ink-300 font-medium mb-1">Bulk import is supported</p>
        <p className="text-xs text-ink-500">
          Upload a CSV for text details now, then manually add photos later for each property.
        </p>
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
                  <div className="w-full h-full flex items-center justify-center flex-col gap-2">
                    <ImageOff size={24} className="text-ink-600" />
                    <span className="text-[11px] text-ink-500">No photos yet</span>
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
                    title="Edit Property"
                  >
                    <Pencil size={13} />
                  </button>

                  <button
                    onClick={() => setConfirm(p)}
                    className="p-1.5 rounded hover:bg-flame-500/10 text-ink-400 hover:text-flame-400 transition-colors"
                    title="Delete Property"
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

      <ImportPreviewModal
        open={showImportModal}
        rows={importRows}
        errors={importErrors}
        importing={importing}
        onClose={() => {
          if (importing) return
          setShowImportModal(false)
        }}
        onImport={handleImport}
      />
    </div>
  )
}