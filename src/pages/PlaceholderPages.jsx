// Groups Page placeholder
import { Users } from 'lucide-react'
export function GroupsPage() {
  return (
    <div className="p-8 fade-up">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-ink-100">Groups</h1>
        <p className="text-sm text-ink-400 mt-1">Manage your Facebook group list</p>
      </div>
      <div className="card p-12 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-ink-700 flex items-center justify-center mb-4">
          <Users size={24} className="text-ink-400" />
        </div>
        <p className="text-ink-300 font-medium mb-1">Day 3 — Coming next</p>
        <p className="text-ink-500 text-sm">Group manager with CSV import built here.</p>
      </div>
    </div>
  )
}

// Campaign Builder placeholder
import { Megaphone } from 'lucide-react'
export function CampaignPage() {
  return (
    <div className="p-8 fade-up">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-ink-100">New Campaign</h1>
        <p className="text-sm text-ink-400 mt-1">Select listings and groups to post</p>
      </div>
      <div className="card p-12 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-ink-700 flex items-center justify-center mb-4">
          <Megaphone size={24} className="text-ink-400" />
        </div>
        <p className="text-ink-300 font-medium mb-1">Day 3 — Coming next</p>
        <p className="text-ink-500 text-sm">Campaign builder with queue preview built here.</p>
      </div>
    </div>
  )
}

// Dashboard placeholder
import { LayoutDashboard } from 'lucide-react'
export function DashboardPage() {
  return (
    <div className="p-8 fade-up">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-ink-100">Dashboard</h1>
        <p className="text-sm text-ink-400 mt-1">Live campaign status</p>
      </div>
      <div className="card p-12 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-ink-700 flex items-center justify-center mb-4">
          <LayoutDashboard size={24} className="text-ink-400" />
        </div>
        <p className="text-ink-300 font-medium mb-1">Day 5 — Coming next</p>
        <p className="text-ink-500 text-sm">Live posting dashboard with progress built here.</p>
      </div>
    </div>
  )
}
