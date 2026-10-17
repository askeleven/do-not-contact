import { createHmac, randomBytes } from 'node:crypto'
import { open, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DncError } from './errors.js'
import { identifiersOf, keyFor, typeOfKey } from './identifiers.js'
import { detectOptOut } from './detect.js'

/**
 * @typedef {import('./identifiers.js').Contact} Contact
 * @typedef {import('./identifiers.js').Identifier} Identifier
 * @typedef {import('./identifiers.js').IdentifierType} IdentifierType
 * @typedef {import('./detect.js').Detection} Detection
 *
 * @typedef {'opt_out'|'opt_in'|'link'} EventType
 *
 * @typedef {object} ListEvent One line of the list file. Never holds an address, a
 *   number or message text: only keys.
 * @property {EventType} type
 * @property {string} at ISO 8601.
 * @property {string[]} keys Everything known to belong to this person when it was recorded.
 * @property {string} [from] The key the request came from, when it came from one.
 * @property {string} [channel] Such as sms, email, whatsapp, phone, web.
 * @property {string} [how] keyword, phrase, wrong_number, manual, unsubscribe_link,
 *   complaint, or your own word.
 * @property {string} [source] Who or what recorded it: an agent's name, a webhook, a person.
 *
 * @typedef {object} Block
 * @property {'opted_out'} code
 * @property {string} at When they opted out.
 * @property {string} [channel]
 * @property {string} [how]
 * @property {string} [source]
 * @property {string} via Which of the person's identifiers it came from, in words:
 *   "this phone", "a linked email".
 *
 * @typedef {object} CheckResult
 * @property {boolean} allowed
 * @property {'allow'|'block'} verdict
 * @property {Block[]} blocks Newest first. Empty when allowed.
 * @property {number} linked How many identifiers are known for this person, including
 *   the ones checked.
 *
 * @typedef {object} RecordOptions
 * @property {string} [channel]
 * @property {string} [how]
 * @property {string} [source]
 * @property {Date | number | string} [at] When it happened. Default now.
 *
 * @typedef {object} InboundOptions
 * @property {string} [channel]
 * @property {string} [source]
 * @property {Contact} [also] Other identifiers you know for the sender. An opt-out then
 *   blocks those too, now and later.
 * @property {Date | number | string} [at]
 *
 * @typedef {object} InboundResult
 * @property {Detection} detection
 * @property {'opted_out'|'opted_in'|'wrong_number'|'nothing'} recorded
 *
 * @typedef {object} ListOptions
 * @property {string} secret Keys the hashes. At least 32 characters. The same list needs
 *   the same secret every time: with another one, nothing on it would match.
 * @property {string} [defaultCountry] Calling code for numbers written without one.
 * @property {() => Date | number} [now] The clock, for tests.
 *
 * @typedef {object} Stats
 * @property {number} people People who are blocked now.
 * @property {number} identifiers Identifiers on the list, blocked or not.
 * @property {Record<IdentifierType, number>} blockedByType Blocked identifiers by type.
 * @property {number} optOuts
 * @property {number} optIns
 * @property {string | null} lastOptOut
 * @property {number} skipped Lines that could not be read.
 */

export const MIN_SECRET_LENGTH = 32

const KEY_PATTERN = /^[epi]:[0-9a-f]{32}$/

/**
 * A do-not-contact list in an append-only JSONL file. Opening an existing list with the
 * wrong secret throws, rather than quietly finding no one on it.
 *
 * @param {string} path
 * @param {ListOptions} options
 */
export function openList(path, options) {
  if (typeof path !== 'string' || !path) throw new DncError('invalid_option', 'openList needs a file path.')
  const secret = options?.secret
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new DncError('invalid_option', `The secret must be at least ${MIN_SECRET_LENGTH} characters. Make one with: do-not-contact secret`)
  }
  const normalize = { defaultCountry: options.defaultCountry }
  const clock = options.now ?? (() => Date.now())
  const nowIso = () => toIso(clock())
  const check = createHmac('sha256', secret).update('do-not-contact:check').digest('hex').slice(0, 16)

  /**
   * @returns {Promise<{ events: ListEvent[], skipped: number, hasHeader: boolean }>}
   */
  async function load() {
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    const parsed = parseList(text)
    if (parsed.check !== null && parsed.check !== check) {
      throw new DncError('wrong_secret', `${path} was made with a different secret. Nothing on it can be checked with this one.`)
    }
    return { events: parsed.events, skipped: parsed.skipped, hasHeader: parsed.check !== null }
  }

  /**
   * One line, appended and synced before returning: an opt-out is not recorded until it
   * is on disk.
   *
   * @param {ListEvent} event
   */
  async function append(event) {
    const { hasHeader } = await load()
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a')
    try {
      const header = hasHeader ? '' : `${JSON.stringify({ type: 'header', v: 1, check })}\n`
      await handle.write(`${header}${JSON.stringify(event)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * @param {Contact} contact
   * @returns {string[]}
   */
  function keysOf(contact) {
    const ids = identifiersOf(contact, normalize)
    if (ids.length === 0) throw new DncError('invalid_identifier', 'Give at least one email, phone or id.')
    return ids.map((id) => keyFor(secret, id))
  }

  /**
   * @param {EventType} type
   * @param {string[]} keys
   * @param {RecordOptions & { from?: string }} opts
   * @returns {ListEvent}
   */
  function event(type, keys, opts) {
    /** @type {ListEvent} */
    const e = { type, at: opts.at === undefined ? nowIso() : toIso(opts.at), keys }
    if (opts.from) e.from = opts.from
    for (const field of /** @type {const} */ (['channel', 'how', 'source'])) {
      const v = opts[field]
      if (v !== undefined && v !== '') e[field] = String(v).slice(0, 100)
    }
    return e
  }

  const list = {
    /**
     * Whether you may contact this person. Give every identifier you are about to use,
     * and any others you know: the person is blocked if any of them, or anything linked
     * to them, opted out.
     *
     * @param {Contact} contact
     * @returns {Promise<CheckResult>}
     */
    async check(contact) {
      const keys = keysOf(contact)
      const { events } = await load()
      return evaluate(events, keys)
    },

    /**
     * Checks many contacts, reading the list once. A contact whose identifiers cannot be
     * read gets an `error` instead of a result: it could not be checked, so do not
     * contact it.
     *
     * @param {Contact[]} contacts
     * @returns {Promise<Array<CheckResult | { error: string }>>}
     */
    async checkMany(contacts) {
      const { events } = await load()
      return contacts.map((c) => {
        try {
          return evaluate(events, keysOf(c))
        } catch (error) {
          if (error instanceof DncError && error.code === 'invalid_identifier') return { error: error.message }
          throw error
        }
      })
    },

    /**
     * Records an opt-out for everything given. Their identifiers are linked: an opt-out
     * from one blocks all of them.
     *
     * @param {Contact} contact
     * @param {RecordOptions} [opts]
     * @returns {Promise<ListEvent>}
     */
    async optOut(contact, opts = {}) {
      const keys = keysOf(contact)
      const e = event('opt_out', keys, { how: 'manual', ...opts })
      await append(e)
      return e
    },

    /**
     * Records that someone asked to hear from you again. It lifts only the opt-outs that
     * came from identifiers given here, so a person who texted STOP has to opt back in
     * from that phone, not by email. Keep proof of it: pass it as `source`.
     *
     * @param {Contact} contact
     * @param {RecordOptions} [opts]
     * @returns {Promise<ListEvent>}
     */
    async optIn(contact, opts = {}) {
      const keys = keysOf(contact)
      const e = event('opt_in', keys, { how: 'manual', ...opts })
      await append(e)
      return e
    },

    /**
     * Records that these identifiers belong to one person. Linking never lifts a block;
     * it only spreads one.
     *
     * @param {Contact} contact
     * @param {RecordOptions} [opts]
     * @returns {Promise<ListEvent>}
     */
    async link(contact, opts = {}) {
      const keys = keysOf(contact)
      if (keys.length < 2) throw new DncError('invalid_identifier', 'Linking needs at least two identifiers.')
      const e = event('link', keys, opts)
      await append(e)
      return e
    },

    /**
     * Reads an inbound message and records what it asks for: STOP, unsubscribe and
     * "remove me" block the sender and everything in `also`; START or UNSTOP lifts an
     * opt-out from this sender; "wrong number" blocks that number only, because it is not
     * the person you meant. Nothing is recorded for anything else.
     *
     * @param {string} from The sender: an address, number, or namespace:value.
     * @param {string} text What they wrote.
     * @param {InboundOptions} [opts]
     * @returns {Promise<InboundResult>}
     */
    async inbound(from, text, opts = {}) {
      const sender = typeof from === 'string' ? from : ''
      const fromContact = contactFromString(sender)
      const fromKey = keysOf(fromContact)[0]
      const detection = detectOptOut(text)
      const base = { channel: opts.channel, source: opts.source, at: opts.at, from: fromKey }
      if (detection.kind === 'opt_out') {
        const keys = unique([fromKey, ...(opts.also ? keysOrEmpty(opts.also) : [])])
        await append(event('opt_out', keys, { ...base, how: /** @type {string} */ (detection.how) }))
        return { detection, recorded: 'opted_out' }
      }
      if (detection.kind === 'wrong_number') {
        await append(event('opt_out', [fromKey], { ...base, how: 'wrong_number' }))
        return { detection, recorded: 'wrong_number' }
      }
      if (detection.kind === 'opt_in') {
        await append(event('opt_in', [fromKey], { ...base, how: 'keyword' }))
        return { detection, recorded: 'opted_in' }
      }
      return { detection, recorded: 'nothing' }
    },

    /**
     * Counts, without saying who.
     *
     * @returns {Promise<Stats>}
     */
    async stats() {
      const { events, skipped } = await load()
      const graph = buildGraph(events)
      /** @type {Set<string>} */
      const blockedRoots = new Set()
      /** @type {Record<IdentifierType, number>} */
      const blockedByType = { email: 0, phone: 0, id: 0 }
      for (const key of graph.keys()) {
        const root = find(graph, key)
        if (!blockedRoots.has(root) && evaluate(events, [key]).blocks.length) blockedRoots.add(root)
      }
      for (const key of graph.keys()) if (blockedRoots.has(find(graph, key))) blockedByType[typeOfKey(key)]++
      const optOuts = events.filter((e) => e.type === 'opt_out')
      return {
        people: blockedRoots.size,
        identifiers: graph.size,
        blockedByType,
        optOuts: optOuts.length,
        optIns: events.filter((e) => e.type === 'opt_in').length,
        lastOptOut: optOuts.length ? optOuts.map((e) => e.at).sort().at(-1) ?? null : null,
        skipped,
      }
    },
  }

  /**
   * @param {Contact} contact
   * @returns {string[]}
   */
  function keysOrEmpty(contact) {
    try {
      return keysOf(contact)
    } catch (error) {
      if (error instanceof DncError && error.code === 'invalid_identifier' && /at least one/.test(error.message)) return []
      throw error
    }
  }

  return list
}

/** @typedef {ReturnType<typeof openList>} DncList */

/**
 * A contact from one identifier written as text.
 *
 * @param {string} text
 * @returns {Contact}
 */
export function contactFromString(text) {
  const s = String(text).trim()
  if (/^mailto:/i.test(s) || (s.includes('@') && !/^[a-z][\w.-]*:[^@]*$/i.test(s))) return { email: s }
  if (/^(?:tel|sms|whatsapp):/i.test(s) || /^\+?[\d\s().\-/]+$/.test(s)) return { phone: s }
  return { id: s }
}

/**
 * Whether the keys' person is blocked: some opt-out among everything linked to them
 * that no later opt-in from the same place has lifted.
 *
 * @param {ListEvent[]} events
 * @param {string[]} keys
 * @returns {CheckResult}
 */
function evaluate(events, keys) {
  const graph = buildGraph(events)
  /** @type {Set<string>} */
  const roots = new Set()
  for (const k of keys) roots.add(graph.has(k) ? find(graph, k) : k)
  /** @type {Set<string>} */
  const person = new Set(keys)
  for (const k of graph.keys()) if (roots.has(find(graph, k))) person.add(k)

  const optIns = events.filter((e) => e.type === 'opt_in')
  /** @type {Block[]} */
  const blocks = []
  for (const e of events) {
    if (e.type !== 'opt_out' || !e.keys.some((k) => person.has(k))) continue
    // "Wrong number" says the number is not this person's, so it blocks the number, not
    // whoever it was linked to.
    if (e.how === 'wrong_number' && !e.keys.some((k) => keys.includes(k))) continue
    const origin = e.from ? [e.from] : e.keys
    const lifted = optIns.some((o) => o.at > e.at && origin.every((k) => o.keys.includes(k)))
    if (lifted) continue
    const via = e.from ?? e.keys.find((k) => keys.includes(k)) ?? e.keys[0]
    /** @type {Block} */
    const b = { code: 'opted_out', at: e.at, via: `${keys.includes(via) ? 'this' : 'a linked'} ${typeOfKey(via)}` }
    if (e.channel) b.channel = e.channel
    if (e.how) b.how = e.how
    if (e.source) b.source = e.source
    blocks.push(b)
  }
  blocks.sort((a, b) => (a.at < b.at ? 1 : -1))
  return { allowed: blocks.length === 0, verdict: blocks.length ? 'block' : 'allow', blocks, linked: person.size }
}

/**
 * Union-find over every key, joined by every event that names more than one. A
 * wrong-number opt-out names one key, so it never links.
 *
 * @param {ListEvent[]} events
 * @returns {Map<string, string>}
 */
function buildGraph(events) {
  /** @type {Map<string, string>} */
  const parent = new Map()
  for (const e of events) {
    for (const k of e.keys) if (!parent.has(k)) parent.set(k, k)
    if (e.from && !parent.has(e.from)) parent.set(e.from, e.from)
    for (let i = 1; i < e.keys.length; i++) {
      const a = find(parent, e.keys[0])
      const b = find(parent, e.keys[i])
      if (a !== b) parent.set(b, a)
    }
  }
  return parent
}

/**
 * @param {Map<string, string>} parent
 * @param {string} key
 * @returns {string}
 */
function find(parent, key) {
  let root = key
  while (parent.get(root) !== root) {
    const next = parent.get(root)
    if (next === undefined) return key
    root = next
  }
  // Path compression.
  let k = key
  while (parent.get(k) !== root) {
    const next = /** @type {string} */ (parent.get(k))
    parent.set(k, root)
    k = next
  }
  return root
}

/**
 * Reads a list file. Lines that are not events are skipped and counted; a torn last
 * line is a write that never returned.
 *
 * @param {string} text
 * @returns {{ events: ListEvent[], skipped: number, check: string | null }}
 */
export function parseList(text) {
  /** @type {ListEvent[]} */
  const events = []
  let skipped = 0
  /** @type {string | null} */
  let check = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    /** @type {any} */
    let v
    try {
      v = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (v?.type === 'header' && typeof v.check === 'string') {
      if (check !== null && check !== v.check) throw new DncError('invalid_list', 'The list has headers from two different secrets. Lists made with different secrets cannot be combined.')
      check = v.check
      continue
    }
    const ok =
      v &&
      ['opt_out', 'opt_in', 'link'].includes(v.type) &&
      typeof v.at === 'string' &&
      Number.isFinite(Date.parse(v.at)) &&
      Array.isArray(v.keys) &&
      v.keys.length > 0 &&
      v.keys.every((/** @type {unknown} */ k) => typeof k === 'string' && KEY_PATTERN.test(k)) &&
      (v.from === undefined || (typeof v.from === 'string' && KEY_PATTERN.test(v.from)))
    if (ok) events.push(v)
    else skipped++
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return { events, skipped, check }
}

/**
 * A new random secret, for DNC_SECRET.
 *
 * @returns {string}
 */
export function newSecret() {
  return randomBytes(32).toString('base64url')
}

/**
 * @param {Date | number | string} value
 * @returns {string}
 */
function toIso(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new DncError('invalid_option', `Not a time: ${value}`)
  return d.toISOString()
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function unique(items) {
  return [...new Set(items)]
}
