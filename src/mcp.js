import { createInterface } from 'node:readline'
import { DncError } from './errors.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 *
 * There is deliberately no tool to opt anyone back in. An agent that could lift a block
 * could talk itself past one; opting back in is for people, through the CLI or library.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const MAX_TEXT = 100_000

const INSTRUCTIONS =
  'Call check_contact before every message, call or invite to a person, on any channel, ' +
  'with every email, phone number and id you have for them. If the verdict is block, do ' +
  'not contact them, on that channel or any other: a block covers everything. Do not ' +
  'look for another address or number to reach them. Pass every message you receive to ' +
  'record_inbound, with the sender and any other identifiers you know for them. If someone ' +
  'asks to stop any other way, in a call, in person, on a form, call record_opt_out. You ' +
  'cannot opt anyone back in; tell a person if someone asks to hear from you again.'

const STRINGS = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 50 }],
}

const CONTACT_PROPS = {
  email: { ...STRINGS, description: 'Email address or addresses.' },
  phone: { ...STRINGS, description: 'Phone number or numbers, with country code: +14155550100.' },
  id: { ...STRINGS, description: 'Other handles as namespace:value, such as slack:U024BE7LH.' },
}

/** @type {Array<{ name: string } & Record<string, unknown>>} */
const TOOLS = [
  {
    name: 'check_contact',
    title: 'May I contact this person?',
    description:
      'Checks the do-not-contact list before you contact someone on any channel. Returns ' +
      'allowed (true or false), verdict (allow or block), and for a block when and how they ' +
      'opted out. A person is blocked if any of their identifiers, or any linked to them, ' +
      'opted out, so give every identifier you have.',
    inputSchema: { type: 'object', properties: CONTACT_PROPS, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'record_inbound',
    title: 'Record a message you received',
    description:
      'Reads a message someone sent you and records what it asks for. STOP, unsubscribe, ' +
      '"remove me" and similar block the sender and everything in also_*. START or UNSTOP ' +
      'lifts an opt-out made from the same sender. "Wrong number" blocks that number only. ' +
      'Anything else records nothing. The message text is never stored.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The sender: email address, phone number, or namespace:value.' },
        text: { type: 'string', maxLength: MAX_TEXT, description: 'What they wrote.' },
        channel: { type: 'string', description: 'sms, email, whatsapp, chat...' },
        also_email: { ...STRINGS, description: 'Other email addresses you know for this sender.' },
        also_phone: { ...STRINGS, description: 'Other phone numbers you know for this sender.' },
        also_id: { ...STRINGS, description: 'Other handles you know for this sender.' },
      },
      required: ['from', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'record_opt_out',
    title: 'Record that someone asked to stop',
    description:
      'Blocks a person on every channel, for when they asked to stop in a way record_inbound ' +
      'did not see: on a call, in person, on a form, or in words it did not recognise. Give ' +
      'every identifier you have for them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONTACT_PROPS,
        channel: { type: 'string', description: 'Where they asked: phone, in_person, web, email, sms...' },
        how: { type: 'string', description: 'A word or two: asked on call, form, complaint...' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
]

/**
 * @typedef {object} ServeOptions
 * @property {import('./list.js').DncList} list
 * @property {string} [source] Recorded on every opt-out the agent makes. Default 'agent'.
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 */

/**
 * Serves until the input stream closes. Requests are handled one at a time, in order,
 * so an opt-out is on disk before the check that follows it.
 *
 * @param {ServeOptions} options
 * @returns {Promise<void>}
 */
export function serve(options) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }
  let queue = Promise.resolve()
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    queue = queue.then(() => handleLine(line, send, options))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      queue.then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @param {ServeOptions} options
 * @returns {Promise<void>}
 */
async function handleLine(line, send, options) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.
  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {}, options)
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

class ToolInputError extends Error {}

/**
 * @param {string} method
 * @param {any} params
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function dispatch(method, params, options) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'do-not-contact', title: 'do-not-contact', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {}, options)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message. A check that fails says so plainly: it is not permission to contact.
 *
 * @param {string} name
 * @param {any} args
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function callTool(name, args, options) {
  if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`)
  const source = options.source ?? 'agent'
  try {
    /** @type {Record<string, unknown>} */
    let payload
    if (name === 'check_contact') {
      payload = { ...(await options.list.check(contactArg(args, ''))) }
    } else if (name === 'record_inbound') {
      if (typeof args.from !== 'string' || typeof args.text !== 'string') throw new ToolInputError('from and text must be strings.')
      if (args.text.length > MAX_TEXT) throw new ToolInputError('text is too long.')
      const also = contactArg(args, 'also_')
      const hasAlso = Boolean(also.email || also.phone || also.id)
      const r = await options.list.inbound(args.from, args.text, {
        channel: optionalString(args.channel, 'channel'),
        source,
        also: hasAlso ? also : undefined,
      })
      payload = { recorded: r.recorded, detection: r.detection }
    } else {
      const e = await options.list.optOut(contactArg(args, ''), {
        channel: optionalString(args.channel, 'channel'),
        how: optionalString(args.how, 'how') ?? 'recorded by agent',
        source,
      })
      payload = { recorded: 'opted_out', at: e.at, identifiers: e.keys.length }
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload }
  } catch (error) {
    if (error instanceof DncError || error instanceof ToolInputError) {
      const prefix = name === 'check_contact' ? 'Could not check, so do not contact this person yet: ' : ''
      return { content: [{ type: 'text', text: prefix + error.message }], isError: true }
    }
    throw error
  }
}

/**
 * @param {any} args
 * @param {string} prefix
 * @returns {import('./identifiers.js').Contact}
 */
function contactArg(args, prefix) {
  /** @type {import('./identifiers.js').Contact} */
  const c = {}
  for (const field of /** @type {const} */ (['email', 'phone', 'id'])) {
    const v = args[`${prefix}${field}`]
    if (v === undefined) continue
    const ok = typeof v === 'string' || (Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string'))
    if (!ok) throw new ToolInputError(`${prefix}${field} must be a string or a list of strings.`)
    c[field] = v
  }
  return c
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {string | undefined}
 */
function optionalString(v, name) {
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`${name} must be a string.`)
  return v
}
