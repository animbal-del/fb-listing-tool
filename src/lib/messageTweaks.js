// messageTweaks.js — rule-based variations of a message for different groups.
// Variation 0 is always the original text. Variations 1, 2, … rotate:
//   • emojis within small sets of look-alikes (🏠 → 🏡 → 🏘️)
//   • a greeting at the start of the first line ("Hi everyone" → "Hello all")
//   • a known call-to-action on the last line ("DM for details" → "Message me for details")
//   • the bullet character at the start of list lines (• → ▪ → ➤)
// Nothing else is touched: no numbers, prices, phone numbers, links or other words.

const EMOJI_SETS = [
  ['🏠', '🏡', '🏘️'],
  ['✅', '✔️', '☑️'],
  ['📞', '☎️', '📱'],
  ['👋', '🙋', '🙌'],
  ['🔥', '⚡', '💥'],
  ['👉', '➡️', '▶️'],
  ['⭐', '🌟', '✨'],
  ['📍', '📌'],
  ['🙏', '😊'],
]

const GREETINGS = ['Hi everyone', 'Hello all', 'Hey folks', 'Hello everyone']
const GREETING_RE = /^(\s*)(hi|hello|hey|greetings)(?:\s+(?:everyone|all|folks|friends|guys|there))?(?=$|[\s!,.:])/i

const CLOSINGS = [
  'DM for details',
  'Message me for details',
  'Feel free to reach out',
  'Inbox for more details',
]

const BULLETS = ['•', '▪', '➤']
const BULLET_RE = /^(\s*)[•▪➤](\s+)/

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const baseEmoji = s => s.replace(/️/g, '')
const norm = s => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()

function rotate(list, currentIndex, i) {
  return list[(currentIndex + i) % list.length]
}

function swapEmojis(text, i) {
  const members = EMOJI_SETS.flat().map(baseEmoji).sort((a, b) => b.length - a.length)
  const re = new RegExp(`(?:${members.map(escapeRe).join('|')})\\uFE0F?`, 'gu')
  return text.replace(re, match => {
    const base = baseEmoji(match)
    const set = EMOJI_SETS.find(s => s.some(e => baseEmoji(e) === base))
    const idx = set.findIndex(e => baseEmoji(e) === base)
    return rotate(set, idx, i)
  })
}

function swapGreeting(lines, i) {
  const first = lines.findIndex(l => l.trim())
  if (first < 0) return
  const m = lines[first].match(GREETING_RE)
  if (!m) return
  const current = GREETINGS.findIndex(g => g.toLowerCase() === m[0].trim().toLowerCase())
  lines[first] = m[1] + rotate(GREETINGS, Math.max(current, 0), current < 0 ? i - 1 : i) +
    lines[first].slice(m[0].length)
}

function swapClosing(lines, i) {
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 0) return
  const line = lines[last]
  const current = CLOSINGS.findIndex(c => norm(c) === norm(line))
  if (current < 0) return
  // keep any emoji / punctuation around the phrase
  const lead = line.match(/^[^A-Za-z]*/)[0]
  const trail = line.match(/[^A-Za-z]*$/)[0]
  lines[last] = lead + rotate(CLOSINGS, current, i) + trail
}

function swapBullets(lines, i) {
  const bullet = BULLETS[i % BULLETS.length]
  for (let n = 0; n < lines.length; n++) {
    lines[n] = lines[n].replace(BULLET_RE, (_, sp, gap) => sp + bullet + gap)
  }
}

export function tweakMessage(text, variation) {
  if (!variation) return text
  const lines = swapEmojis(text, variation).split('\n')
  swapGreeting(lines, variation)
  swapClosing(lines, variation)
  swapBullets(lines, variation)
  return lines.join('\n')
}

export function canTweak(text) {
  return tweakMessage(text, 1) !== text
}

// Text for each group in order; with tweaks off every group gets the original
export function messageTextsForGroups(text, groupCount, tweaksOn) {
  return Array.from({ length: groupCount }, (_, i) => (tweaksOn ? tweakMessage(text, i) : text))
}

export function hasLink(text) {
  return /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|co|ly|me|io|app|link|gl|gle)\b/i.test(text || '')
}
