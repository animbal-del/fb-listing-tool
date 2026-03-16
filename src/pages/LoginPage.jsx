import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { Home, AlertCircle } from 'lucide-react'

export default function LoginPage() {
  const { signIn } = useAuth()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: 'radial-gradient(ellipse at 50% 0%, #1E2B45 0%, #0A1120 70%)' }}>
      <div className="w-full max-w-sm fade-up">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-flame-500 flex items-center justify-center">
            <Home size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-ink-100 tracking-tight">Listing Poster</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-ink-100 mb-1">Sign in</h1>
          <p className="text-sm text-ink-400 mb-6">Enter your Supabase auth credentials</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-flame-500/10 border border-flame-500/20 text-flame-400 text-sm">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full justify-center" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-ink-500 mt-4">
          Create a user in Supabase Dashboard → Authentication → Users
        </p>
      </div>
    </div>
  )
}
