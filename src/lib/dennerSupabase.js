import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_DENNER_SUPABASE_URL
const key = import.meta.env.VITE_DENNER_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Missing Denner Supabase env vars (VITE_DENNER_SUPABASE_URL / VITE_DENNER_SUPABASE_ANON_KEY).')
}

export const dennerSupabase = createClient(url, key)
