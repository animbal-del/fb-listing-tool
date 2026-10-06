// DNR flat codes (inventory_flats.flat_code, e.g. "DNR-00561") — display tag + search matching

export function DnrTag({ code, className = '' }) {
  if (!code) return null
  return (
    <span className={`font-mono text-[11px] text-ink-500 bg-ink-800 border border-ink-700 rounded px-1.5 py-px whitespace-nowrap ${className}`}>
      {code}
    </span>
  )
}

// Matches a flat by name, locality or DNR code.
// "DNR-00561", "dnr00561", "dnr 561", "00561" and "561" all find DNR-00561.
export function matchesFlatSearch(flat, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true

  const haystack = [flat.title, flat.society_name, flat.locality, flat.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (haystack.includes(q)) return true

  const m = q.match(/^(?:dnr)?[\s-]*0*(\d+)$/)
  if (m && flat.code) {
    return Number.parseInt(flat.code.replace(/\D/g, ''), 10) === Number.parseInt(m[1], 10)
  }
  return false
}
