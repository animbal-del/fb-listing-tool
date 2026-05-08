import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_DENNER_SUPABASE_URL
const key = import.meta.env.VITE_DENNER_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error(
    '[dennerSupabase] Missing env vars: VITE_DENNER_SUPABASE_URL / VITE_DENNER_SUPABASE_ANON_KEY. ' +
    'Add them in Vercel → Project → Settings → Environment Variables.'
  )
}

export const dennerSupabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder'
)
