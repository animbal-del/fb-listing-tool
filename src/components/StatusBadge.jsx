export default function StatusBadge({ status }) {
  const map = {
    available: { label: 'Available',  cls: 'badge-available' },
    rented:    { label: 'Rented Out', cls: 'badge-rented'    },
    pending:   { label: 'Pending',    cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-ink-700 text-ink-300 border border-ink-600' },
    posted:    { label: 'Posted',     cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-jade-500/15 text-jade-400 border border-jade-500/25' },
    skipped:   { label: 'Skipped',    cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-ink-700 text-ink-400 border border-ink-600' },
    failed:    { label: 'Failed',     cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-flame-500/15 text-flame-400 border border-flame-500/25' },
    active:    { label: 'Active',     cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-jade-500/15 text-jade-400 border border-jade-500/25' },
    paused:    { label: 'Paused',     cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400 border border-yellow-500/25' },
    completed: { label: 'Completed',  cls: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-ink-600 text-ink-300 border border-ink-500' },
  }
  const { label, cls } = map[status] || { label: status, cls: 'badge-rented' }
  return <span className={cls}>{label}</span>
}
