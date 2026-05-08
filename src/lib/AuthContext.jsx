import { createContext, useContext, useEffect, useState } from 'react'
import { dennerSupabase } from '../lib/dennerSupabase'

// Auth is handled via Denner's Supabase so that admin-role RLS policies
// on inventory tables resolve correctly via auth.uid() → profiles.role
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    dennerSupabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })
    const { data: { subscription } } = dennerSupabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const signIn  = (email, password) => dennerSupabase.auth.signInWithPassword({ email, password })
  const signOut = () => dennerSupabase.auth.signOut()

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
