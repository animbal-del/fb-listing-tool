import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { Home, Users, Megaphone, LayoutDashboard, LogOut } from 'lucide-react'

const NAV = [
  { to: '/properties', icon: Home,           label: 'Properties'   },
  { to: '/groups',     icon: Users,           label: 'Groups'       },
  { to: '/campaign',   icon: Megaphone,       label: 'New Campaign' },
  { to: '/dashboard',  icon: LayoutDashboard, label: 'Dashboard'    },
]

export default function Layout({ children }) {
  const { signOut, user } = useAuth()

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — fixed height, never scrolls */}
      <aside className="w-56 bg-ink-900 border-r border-ink-800 flex flex-col shrink-0 h-screen">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-ink-800 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-flame-500 flex items-center justify-center shrink-0">
            <Home size={15} className="text-white" />
          </div>
          <span className="font-semibold text-ink-100 text-sm tracking-tight leading-tight">
            Listing<br/>Poster
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-flame-500/15 text-flame-400'
                    : 'text-ink-400 hover:text-ink-200 hover:bg-ink-800'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer — always visible at bottom */}
        <div className="px-3 pb-4 border-t border-ink-800 pt-4 shrink-0">
          <p className="text-xs text-ink-500 px-3 mb-2 truncate">{user?.email}</p>
          <button
            onClick={signOut}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-ink-400 hover:text-flame-400 hover:bg-ink-800 transition-colors w-full"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content — scrolls independently */}
      <main className="flex-1 overflow-y-auto bg-ink-900 h-screen">
        {children}
      </main>
    </div>
  )
}
