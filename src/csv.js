/**
 * RFC 4180 CSV: commas, double quotes, "" for a quote inside quotes, fields over several
 * lines. A byte order mark is dropped.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '')
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        field += ch
      }
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (ch === '\r' && s[i + 1] === '\n') i++
    } else {
      field += ch
    }
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/**
 * @param {string[][]} rows
 * @returns {string}
 */
export function toCsv(rows) {
  return rows.map((r) => r.map((f) => (/[",\r\n]/.test(f) || /^\s|\s$/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')).join('\n') + (rows.length ? '\n' : '')
}

/**
 * Which columns hold emails and phone numbers, from the header row.
 *
 * @param {string[]} header
 * @returns {{ email: number[], phone: number[] }}
 */
export function contactColumns(header) {
  /** @type {{ email: number[], phone: number[] }} */
  const out = { email: [], phone: [] }
  header.forEach((h, i) => {
    const name = h.trim().toLowerCase()
    if (/\be-?mail\b|email/.test(name)) out.email.push(i)
    else if (/\b(?:phone|mobile|cell|tel|telephone|sms|whatsapp|number)\b/.test(name)) out.phone.push(i)
  })
  return out
}
