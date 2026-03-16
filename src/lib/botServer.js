const BASE = 'http://localhost:3001'

export async function checkServer() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

export async function fetchBots() {
  const r    = await fetch(`${BASE}/bots`)
  const data = await r.json()
  // Handle both array response and {bots:[], error:string} response
  if (Array.isArray(data)) return data
  if (data?.bots) return data.bots
  return []
}

export async function loginBot(id) {
  const r = await fetch(`${BASE}/bots/${id}/login`, { method: 'POST' })
  return r.json()
}

export async function startBot(id, campaignId) {
  const r = await fetch(`${BASE}/bots/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignId }),
  })
  return r.json()
}

export async function stopBot(id) {
  const r = await fetch(`${BASE}/bots/${id}/stop`, { method: 'POST' })
  return r.json()
}

export function streamLogs(id, onLine) {
  const es = new EventSource(`${BASE}/bots/${id}/logs`)
  es.onmessage = e => {
    try { onLine(JSON.parse(e.data).line) } catch {}
  }
  es.onerror = () => {} // suppress console errors on close
  return () => es.close()
}

export async function getBotQueue(id) {
  const r = await fetch(`${BASE}/bots/${id}/queue`)
  return r.json()
}

export async function setBotQueue(id, campaignIds) {
  const r = await fetch(`${BASE}/bots/${id}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignIds }),
  })
  return r.json()
}
