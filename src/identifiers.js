import { createHmac } from 'node:crypto'
import { DncError } from './errors.js'

/**
 * @typedef {'email'|'phone'|'id'} IdentifierType
 *
 * @typedef {object} Identifier
 * @property {IdentifierType} type
 * @property {string} value Normalized: a lower-case address, an E.164 number, or
 *   "namespace:value" for anything else, such as "slack:U024BE7LH".
 *
 * @typedef {object} Contact Any of the ways to reach one person. Give every one you know:
 *   an opt-out recorded against any of them blocks all of them.
 * @property {string | string[]} [email]
 * @property {string | string[]} [phone]
 * @property {string | string[]} [id] Other handles, as "namespace:value".
 *
 * @typedef {object} NormalizeOptions
 * @property {string} [defaultCountry] The calling code for numbers written without one,
 *   such as '1' or '44'. Without it, a number must start with + or 00.
 */

/** Short prefixes keep keys readable as to their type, without saying who. */
const TYPE_PREFIX = /** @type {const} */ ({ email: 'e', phone: 'p', id: 'i' })

/**
 * An address as one person: lower case, display name and "mailto:" removed, and the
 * "+tag" dropped, so dana+news@acme.com is dana@acme.com. Gmail ignores dots, so they are
 * dropped there too. This may treat two people as one on the rare server where tags or
 * dots matter; for a list of people who said stop, blocking too much is the safe error.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeEmail(input) {
  let s = String(input).trim()
  const angle = /<([^<>]+)>\s*$/.exec(s)
  if (angle) s = angle[1]
  s = s.replace(/^mailto:/i, '').trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at < 1 || at === s.length - 1 || /\s/.test(s) || !/^[^@]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(s)) {
    throw new DncError('invalid_identifier', `Not an email address: ${input}`)
  }
  let local = s.slice(0, at)
  let domain = s.slice(at + 1).replace(/\.$/, '')
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

/**
 * A number in E.164: + and 8 to 15 digits. Spaces, dashes, dots, brackets and "tel:" are
 * ignored. A number without + or 00 needs a default country.
 *
 * @param {string} input
 * @param {NormalizeOptions} [options]
 * @returns {string}
 */
export function normalizePhone(input, options = {}) {
  const raw = String(input).trim().replace(/^(?:tel|sms|whatsapp):/i, '')
  if (!/^\+?[\d\s().\-/]+$/.test(raw)) throw new DncError('invalid_identifier', `Not a phone number: ${input}`)
  let digits = raw.replace(/\D/g, '')
  /** @type {string} */
  let e164
  if (raw.startsWith('+')) {
    e164 = `+${digits}`
  } else if (digits.startsWith('00')) {
    e164 = `+${digits.slice(2)}`
  } else {
    const cc = options.defaultCountry?.replace(/^\+/, '')
    if (!cc) {
      throw new DncError(
        'invalid_identifier',
        `${input} has no country code. Write it as +<country><number>, or set a default country.`,
      )
    }
    if (!/^\d{1,3}$/.test(cc)) throw new DncError('invalid_option', `defaultCountry must be a calling code such as 1 or 44, got ${options.defaultCountry}.`)
    if (cc === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
    else if (cc !== '1' && digits.startsWith('0')) digits = digits.slice(1) // The trunk prefix.
    e164 = `+${cc}${digits}`
  }
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new DncError('invalid_identifier', `Not a phone number: ${input}`)
  return e164
}

/**
 * @param {string} input
 * @returns {string}
 */
export function normalizeId(input) {
  const s = String(input).trim()
  const colon = s.indexOf(':')
  if (colon < 1 || colon === s.length - 1) {
    throw new DncError('invalid_identifier', `An id needs a namespace, such as slack:U024BE7LH, got ${input}`)
  }
  return `${s.slice(0, colon).toLowerCase()}:${s.slice(colon + 1).trim()}`
}

/**
 * Reads one identifier written as text: an email address, a phone number, or
 * "namespace:value". "mailto:", "tel:", "sms:" and "whatsapp:" are understood.
 *
 * @param {string} input
 * @param {NormalizeOptions} [options]
 * @returns {Identifier}
 */
export function parseIdentifier(input, options = {}) {
  const s = String(input).trim()
  if (/^mailto:/i.test(s) || (s.includes('@') && !/^[a-z][\w.-]*:/i.test(s.replace(/^mailto:/i, '')))) {
    return { type: 'email', value: normalizeEmail(s) }
  }
  if (/^(?:tel|sms|whatsapp):/i.test(s) || /^\+?[\d\s().\-/]+$/.test(s)) return { type: 'phone', value: normalizePhone(s, options) }
  return { type: 'id', value: normalizeId(s) }
}

/**
 * Every identifier in a contact, normalized, without repeats.
 *
 * @param {Contact} contact
 * @param {NormalizeOptions} [options]
 * @returns {Identifier[]}
 */
export function identifiersOf(contact, options = {}) {
  if (!contact || typeof contact !== 'object') throw new DncError('invalid_identifier', 'A contact is an object with email, phone or id.')
  const list = (/** @type {unknown} */ v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v])
  /** @type {Identifier[]} */
  const out = []
  for (const e of list(contact.email)) out.push({ type: 'email', value: normalizeEmail(String(e)) })
  for (const p of list(contact.phone)) out.push({ type: 'phone', value: normalizePhone(String(p), options) })
  for (const i of list(contact.id)) out.push({ type: 'id', value: normalizeId(String(i)) })
  const seen = new Set()
  return out.filter((x) => {
    const k = `${x.type}:${x.value}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The key stored for an identifier: its type, and an HMAC-SHA256 of it under the list's
 * secret, cut to 128 bits. Without the secret, a key cannot be turned back into an
 * address or number, even by trying every phone number there is.
 *
 * @param {string} secret
 * @param {Identifier} identifier
 * @returns {string}
 */
export function keyFor(secret, identifier) {
  const mac = createHmac('sha256', secret).update(`${identifier.type}:${identifier.value}`).digest('hex').slice(0, 32)
  return `${TYPE_PREFIX[identifier.type]}:${mac}`
}

/**
 * @param {string} key
 * @returns {IdentifierType}
 */
export function typeOfKey(key) {
  return key.startsWith('e:') ? 'email' : key.startsWith('p:') ? 'phone' : 'id'
}
