// postText.js — clean listing text before it is posted to Facebook groups.
// Groups hold posts containing links for admin approval, so every link is removed:
//   • "For photos: <link>" lines
//   • "WhatsApp: <link>" lines (link on the same line or the next one)
//   • any other link (maps, websites, bare domains, emails)
// and the "📞 Call:" label becomes "📩 WhatsApp:" (numbers kept).
// If no contact line is left, the standard numbers are appended.
// Pure text transform — the stored descriptions in Denner's DB are never modified.

const DEFAULT_CONTACT = process.env.POST_CONTACT_NUMBERS || '9156005618 / 7020738841'

const TLDS = 'com|in|net|org|co|ly|me|io|app|link|gl|info|biz|site|xyz|page|to|us|ai|gle'
const LINK_RE = new RegExp(
  String.raw`(?:[\w.+-]+@)?(?:(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/\S*)?)`,
  'gi'
)
const EMOJI = String.raw`[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]`
const LEADING_EMOJI_RE = new RegExp(String.raw`^\s*(?:${EMOJI}+\s*)?`, 'u')
const CALL_RE = new RegExp(String.raw`^(\s*)(?:${EMOJI}+\s*)?call(?:\s+(?:us|now|on))?\s*:\s*`, 'iu')
const ONLY_SYMBOLS_RE = new RegExp(String.raw`^[\s•\-–—|:]*(?:${EMOJI}[\s•\-–—|:]*)*$`, 'u')

export function hasLink(text) {
  LINK_RE.lastIndex = 0
  return LINK_RE.test(text || '')
}

function isLinkOnly(line) {
  return hasLink(line) && line.replace(LINK_RE, '').trim() === ''
}

export function cleanPostText(input) {
  const lines = String(input || '').split(/\r?\n/)
  const out = []

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const label = line.replace(LEADING_EMOJI_RE, '')

    // "For photos: <link>" — drop, plus a link sitting alone on the next line
    if (/^for\s+(?:more\s+)?(?:photos|pics|pictures|images|videos)\b/i.test(label)) {
      if (!hasLink(line) && isLinkOnly(lines[i + 1] || '')) i++
      continue
    }

    // "WhatsApp: <link>" or "WhatsApp:" + link on the next line — drop
    const wa = label.match(/^whats\s*app\s*:?\s*(.*)$/i)
    if (wa) {
      const rest = wa[1].trim()
      if (rest === '' && isLinkOnly(lines[i + 1] || '')) { i++; continue }
      if (rest === '' || isLinkOnly(rest)) continue
    }

    // "📞 Call: 98… / 70…" → "📩 WhatsApp: 98… / 70…"
    line = line.replace(CALL_RE, '$1📩 WhatsApp: ')

    // Any other link: strip it; drop the line if only a label/emoji is left
    if (hasLink(line)) {
      line = line
        .replace(LINK_RE, '')
        .replace(/\s*(?:[A-Za-z]+\s*){1,3}:\s*$/, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/, '')
      if (ONLY_SYMBOLS_RE.test(line)) continue
    }

    out.push(line)
  }

  let text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text && !/whats\s*app\s*:?\s*\+?\d/i.test(text)) {
    text += `\n📩 WhatsApp: ${DEFAULT_CONTACT}`
  }

  return text
}
