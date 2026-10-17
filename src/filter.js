import { parseCsv, contactColumns } from './csv.js'
import { DncError } from './errors.js'

/**
 * @typedef {import('./list.js').DncList} DncList
 *
 * @typedef {object} FilterResult
 * @property {string[]} header
 * @property {string[][]} kept Rows you may contact.
 * @property {string[][]} blocked Rows where someone opted out.
 * @property {Array<{ row: string[], reason: string }>} unchecked Rows that could not be
 *   checked: no contact details, or ones that could not be read. Not safe to contact.
 * @property {{ email: number[], phone: number[] }} columns
 */

/**
 * Splits a CSV into rows you may contact and rows you may not. Columns are found by
 * header name, or given.
 *
 * @param {string} text
 * @param {DncList} list
 * @param {{ email?: string[], phone?: string[] }} [options] Column names to use instead.
 * @returns {Promise<FilterResult>}
 */
export async function filterCsv(text, list, options = {}) {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new DncError('invalid_option', 'The CSV is empty.')
  const [header, ...body] = rows
  const found = contactColumns(header)
  const named = (/** @type {string[] | undefined} */ names, /** @type {number[]} */ fallback) => {
    if (!names) return fallback
    return names.map((n) => {
      const i = header.findIndex((h) => h.trim().toLowerCase() === n.trim().toLowerCase())
      if (i < 0) throw new DncError('invalid_option', `No column named ${n}. Columns: ${header.join(', ')}.`)
      return i
    })
  }
  const columns = { email: named(options.email, found.email), phone: named(options.phone, found.phone) }
  if (columns.email.length + columns.phone.length === 0) {
    throw new DncError('invalid_option', `Found no email or phone column in: ${header.join(', ')}. Name them with --email-column or --phone-column.`)
  }

  const contacts = body.map((r) => ({
    email: columns.email.map((i) => (r[i] ?? '').trim()).filter(Boolean),
    phone: columns.phone.map((i) => (r[i] ?? '').trim()).filter(Boolean),
  }))
  const checkable = contacts.map((c) => c.email.length + c.phone.length > 0)
  const results = await list.checkMany(contacts.filter((_, i) => checkable[i]))

  /** @type {FilterResult} */
  const out = { header, kept: [], blocked: [], unchecked: [], columns }
  let n = 0
  body.forEach((row, i) => {
    if (!checkable[i]) {
      out.unchecked.push({ row, reason: 'no email or phone' })
      return
    }
    const r = results[n++]
    if ('error' in r) out.unchecked.push({ row, reason: r.error })
    else if (r.allowed) out.kept.push(row)
    else out.blocked.push(row)
  })
  return out
}
