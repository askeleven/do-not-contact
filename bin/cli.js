#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { openList, newSecret, contactFromString, filterCsv, toCsv, DncError, MIN_SECRET_LENGTH } from '../src/index.js'
import { formatCheck, formatStats } from '../src/report.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'

const USAGE = `
do-not-contact check <identifier...>
do-not-contact inbound --from <identifier> [--also <identifier>]... <text|file|->
do-not-contact optout <identifier...>
do-not-contact optin <identifier...> --source <proof>
do-not-contact link <identifier...>
do-not-contact filter <file.csv>
do-not-contact stats
do-not-contact mcp
do-not-contact secret

  One do-not-contact list for every channel. A STOP by text, an unsubscribe, or
  "please remove me" in a reply blocks that person on email, SMS, calls and
  everything else. The list stores keyed hashes, never addresses or numbers.

  An identifier is an email address, a phone number with its country code, or
  namespace:value for anything else (slack:U024BE7LH). Give every one you know
  for the person: an opt-out from any of them blocks all of them.

Options
  --list <file>         The list. Default $DNC_LIST.
                        The secret comes from $DNC_SECRET, at least ${MIN_SECRET_LENGTH}
                        characters; make one with "secret". Keep it safe: without
                        it, nothing on the list can be checked.
  --country <code>      Calling code for numbers without one, such as 1 or 44.
                        Default $DNC_DEFAULT_COUNTRY.
  --channel <name>      Where it happened: sms, email, phone, web...
  --how <words>         How they asked, for optout: form, call, complaint...
  --source <text>       Who recorded it. For optin, the proof they asked.
  --json                Machine-readable output.
  --no-colour           Plain text.
  --version, --help

inbound
  --from <identifier>   Who sent it.
  --also <identifier>   Other identifiers you know for the sender. Repeatable.
  Records STOP, unsubscribe and "remove me" as opt-outs, START and UNSTOP as
  opt-ins from that sender, and "wrong number" as an opt-out of that number
  alone. The text is never stored.

filter
  Writes the rows you may contact to standard output, and a summary to
  standard error. Email and phone columns are found by name.
  --email-column <name>, --phone-column <name>   Repeatable.
  --blocked <file>      Also write the rows that are blocked.
  --unchecked <file>    Also write the rows that could not be checked.

Exit codes
  0  check: allowed. Otherwise: done.
  1  check: blocked.
  2  could not run. For check, that is not permission to contact.

Examples
  export DNC_LIST=dnc.jsonl DNC_SECRET=$(npx @askeleven/do-not-contact secret)
  npx @askeleven/do-not-contact inbound --from +14155550100 --also dana@acme.com "STOP"
  npx @askeleven/do-not-contact check dana@acme.com
  npx @askeleven/do-not-contact filter leads.csv > leads-ok.csv
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        list: { type: 'string' },
        country: { type: 'string' },
        channel: { type: 'string' },
        how: { type: 'string' },
        source: { type: 'string' },
        from: { type: 'string' },
        also: { type: 'string', multiple: true },
        'email-column': { type: 'string', multiple: true },
        'phone-column': { type: 'string', multiple: true },
        blocked: { type: 'string' },
        unchecked: { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const [sub, ...args] = positionals
  if (sub === 'secret') {
    process.stdout.write(`${newSecret()}\n`)
    return 0
  }
  if (!['check', 'inbound', 'optout', 'optin', 'link', 'filter', 'stats', 'mcp'].includes(sub ?? '')) {
    process.stderr.write(`${sub ? `Unknown command: ${sub}\n` : ''}${USAGE}`)
    return 2
  }

  try {
    const path = values.list ?? process.env.DNC_LIST
    if (!path) throw new UsageError('Give the list file with --list, or set DNC_LIST.')
    const secret = process.env.DNC_SECRET
    if (!secret) throw new UsageError('Set DNC_SECRET, the secret this list is keyed with. A new list: do-not-contact secret')
    const list = openList(path, { secret, defaultCountry: values.country ?? process.env.DNC_DEFAULT_COUNTRY })
    const colour = useColour(values)
    const record = { channel: values.channel, how: values.how, source: values.source }

    if (sub === 'mcp') {
      await serve({ list, source: values.source })
      return 0
    }
    if (sub === 'stats') {
      const s = await list.stats()
      process.stdout.write(values.json ? `${JSON.stringify(s, null, 2)}\n` : formatStats(s))
      return 0
    }
    if (sub === 'filter') return await filter(list, args, values)

    if (sub === 'inbound') {
      if (!values.from) throw new UsageError('inbound needs --from.')
      const text = await readInput(args)
      const also = mergeContacts(values.also ?? [])
      const r = await list.inbound(values.from, text, { channel: values.channel, source: values.source, also })
      const said = {
        opted_out: `Opted out: ${values.from}${values.also?.length ? ` and ${values.also.length} linked` : ''}, on every channel.`,
        opted_in: `Opted back in: ${values.from}, for opt-outs made from it.`,
        wrong_number: `Wrong number: ${values.from} is blocked. Nothing else is linked to it.`,
        nothing: 'Not an opt-out or opt-in. Nothing recorded.',
      }[r.recorded]
      process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : `${said}${r.detection.match ? `  ("${r.detection.match}")` : ''}\n`)
      return 0
    }

    if (args.length === 0) throw new UsageError(`${sub} needs at least one identifier.`)
    const contact = mergeContacts(args)

    if (sub === 'check') {
      const r = await list.check(contact)
      process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : formatCheck(r, { colour }))
      return r.allowed ? 0 : 1
    }
    if (sub === 'optout') {
      const e = await list.optOut(contact, record)
      process.stdout.write(values.json ? `${JSON.stringify(e)}\n` : `Opted out on every channel: ${args.join(', ')}.\n`)
      return 0
    }
    if (sub === 'optin') {
      if (!values.source) throw new UsageError('optin needs --source: the proof they asked, such as "replied START 2026-10-16" or a form id.')
      const e = await list.optIn(contact, record)
      process.stdout.write(values.json ? `${JSON.stringify(e)}\n` : `Opted back in: ${args.join(', ')}. Opt-outs made from anything else still stand.\n`)
      return 0
    }
    // link
    const e = await list.link(contact, record)
    process.stdout.write(values.json ? `${JSON.stringify(e)}\n` : `Linked ${e.keys.length} identifiers as one person.\n`)
    return 0
  } catch (error) {
    if (error instanceof DncError || error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EACCES') {
      process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
      return 2
    }
    throw error
  }
}

class UsageError extends Error {}

/**
 * @param {import('../src/list.js').DncList} list
 * @param {string[]} args
 * @param {Record<string, any>} values
 * @returns {Promise<number>}
 */
async function filter(list, args, values) {
  if (args.length !== 1) throw new UsageError('filter needs one CSV file.')
  const r = await filterCsv(await readFile(args[0], 'utf8'), list, {
    email: values['email-column'],
    phone: values['phone-column'],
  })
  process.stdout.write(toCsv([r.header, ...r.kept]))
  if (values.blocked) await writeFile(values.blocked, toCsv([r.header, ...r.blocked]))
  if (values.unchecked) await writeFile(values.unchecked, toCsv([[...r.header, 'reason'], ...r.unchecked.map((u) => [...u.row, u.reason])]))
  const names = (/** @type {number[]} */ cols) => cols.map((i) => r.header[i]).join(', ') || 'none'
  process.stderr.write(
    `${r.kept.length} may be contacted, ${r.blocked.length} blocked, ${r.unchecked.length} could not be checked ` +
      `(left out). Email columns: ${names(r.columns.email)}. Phone columns: ${names(r.columns.phone)}.\n`,
  )
  return 0
}

/**
 * @param {string[]} identifiers
 * @returns {import('../src/identifiers.js').Contact}
 */
function mergeContacts(identifiers) {
  /** @type {{ email: string[], phone: string[], id: string[] }} */
  const c = { email: [], phone: [], id: [] }
  for (const s of identifiers) {
    const one = contactFromString(s)
    if (one.email) c.email.push(String(one.email))
    else if (one.phone) c.phone.push(String(one.phone))
    else if (one.id) c.id.push(String(one.id))
  }
  return c
}

/**
 * A file's contents when the one argument names a file, standard input for "-" or
 * nothing, and the arguments joined otherwise.
 *
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function readInput(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '-')) {
    if (process.stdin.isTTY) throw new UsageError('Give the message text, a file, or pipe it in.')
    /** @type {Buffer[]} */
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  if (args.length === 1 && existsSync(args[0]) && statSync(args[0]).isFile()) return readFile(args[0], 'utf8')
  return args.join(' ')
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
