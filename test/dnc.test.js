import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openList,
  parseList,
  detectOptOut,
  normalizeEmail,
  normalizePhone,
  parseIdentifier,
  filterCsv,
  parseCsv,
  toCsv,
  newSecret,
  DncError,
} from '../src/index.js'
import { formatCheck } from '../src/report.js'
import { serve } from '../src/mcp.js'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const SECRET = 'test-secret-0123456789-abcdefghijklmnop'
const tmp = () => mkdtempSync(join(tmpdir(), 'dnc-'))

function setup() {
  let t = Date.parse('2026-10-16T14:00:00Z')
  const now = () => t
  const advance = (/** @type {number} */ ms) => {
    t += ms
  }
  const path = join(tmp(), 'dnc.jsonl')
  const list = openList(path, { secret: SECRET, defaultCountry: '1', now })
  return { list, path, advance }
}

// ---------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------

test('detects opt-outs, opt-ins and wrong numbers', () => {
  const cases = /** @type {Array<[string, string]>} */ ([
    ['STOP', 'opt_out'],
    ['stop.', 'opt_out'],
    ['Unsubscribe', 'opt_out'],
    ['CANCEL', 'opt_out'],
    ['revoke', 'opt_out'],
    ['opt out', 'opt_out'],
    ['please stop texting me', 'opt_out'],
    ['Please remove me from your mailing list', 'opt_out'],
    ['take me off your list please', 'opt_out'],
    ['How do I unsubscribe from these?', 'opt_out'],
    ["I don't want your emails", 'opt_out'],
    ['Do not contact me.', 'opt_out'],
    ['never text me again', 'opt_out'],
    ['START', 'opt_in'],
    ['unstop', 'opt_in'],
    ['Wrong number', 'wrong_number'],
    ["Sorry, this isn't Dana's number", 'wrong_number'],
    // People who did not ask to stop.
    ['stop by the office tomorrow?', 'none'],
    ['cancel my appointment', 'none'],
    ['Can you remove me from the meeting invite?', 'none'],
    ["Don't stop sending updates!", 'none'],
    ["Please don't call me before 9am", 'none'],
    ["don't call me, text me instead", 'none'],
    ["I can't stop smiling", 'none'],
    ['Thanks!\n\nOn Mon, Bob wrote:\n> Reply STOP to opt out', 'none'],
    ['', 'none'],
  ])
  for (const [text, kind] of cases) assert.equal(detectOptOut(text).kind, kind, JSON.stringify(text))
  assert.deepEqual(detectOptOut('STOP'), { kind: 'opt_out', how: 'keyword', match: 'STOP' })
  assert.equal(detectOptOut('please stop texting me').how, 'phrase')
})

// ---------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------

test('identifiers are normalized to one form per person', () => {
  assert.equal(normalizeEmail('Dana Lee <Dana+News@ACME.com>'), 'dana@acme.com')
  assert.equal(normalizeEmail('mailto:d.a.n.a@googlemail.com'), 'dana@gmail.com')
  assert.equal(normalizeEmail('d.lee@acme.com'), 'd.lee@acme.com', 'dots matter outside Gmail')
  assert.throws(() => normalizeEmail('not an email'), DncError)

  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100')
  assert.equal(normalizePhone('0044 20 7946 0958'), '+442079460958')
  assert.equal(normalizePhone('415.555.0100', { defaultCountry: '1' }), '+14155550100')
  assert.equal(normalizePhone('1-415-555-0100', { defaultCountry: '1' }), '+14155550100')
  assert.equal(normalizePhone('020 7946 0958', { defaultCountry: '44' }), '+442079460958')
  assert.equal(normalizePhone('tel:+14155550100'), '+14155550100')
  assert.throws(() => normalizePhone('415 555 0100'), /no country code/)
  assert.throws(() => normalizePhone('+1 555'), DncError)
  assert.throws(() => normalizePhone('call me'), DncError)

  assert.deepEqual(parseIdentifier('Slack:U024BE7LH'), { type: 'id', value: 'slack:U024BE7LH' })
  assert.deepEqual(parseIdentifier('whatsapp:+447700900123'), { type: 'phone', value: '+447700900123' })
  assert.deepEqual(parseIdentifier('dana@acme.com'), { type: 'email', value: 'dana@acme.com' })
})

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

test('a STOP by text blocks the same person by email', async () => {
  const { list } = setup()
  assert.equal((await list.check({ email: 'dana@acme.com' })).allowed, true)
  const r = await list.inbound('+14155550100', 'STOP', { channel: 'sms', also: { email: 'Dana@Acme.com' } })
  assert.equal(r.recorded, 'opted_out')

  const byEmail = await list.check({ email: 'dana+promo@acme.com' })
  assert.equal(byEmail.allowed, false)
  assert.equal(byEmail.verdict, 'block')
  assert.deepEqual(byEmail.blocks, [{ code: 'opted_out', at: '2026-10-16T14:00:00.000Z', via: 'a linked phone', channel: 'sms', how: 'keyword' }])
  assert.equal((await list.check({ phone: '(415) 555-0100' })).blocks[0].via, 'this phone')
})

test('identifiers linked later are blocked too, and checking any one finds the person', async () => {
  const { list, advance } = setup()
  await list.inbound('dana@acme.com', 'Please remove me from your mailing list', { channel: 'email' })
  assert.equal((await list.check({ phone: '+14155550100' })).allowed, true)
  advance(1000)
  await list.link({ email: 'dana@acme.com', phone: '+14155550100' })
  assert.equal((await list.check({ phone: '+14155550100' })).allowed, false)
  // A check that names both is blocked even with no link recorded.
  assert.equal((await list.check({ phone: '+12125550199', email: 'dana@acme.com' })).allowed, false)
  assert.equal((await list.check({ phone: '+12125550199' })).allowed, true)
})

test('opting back in has to come from where they opted out', async () => {
  const { list, advance } = setup()
  await list.inbound('+14155550100', 'STOP', { channel: 'sms', also: { email: 'dana@acme.com' } })
  advance(60_000)
  await list.optIn({ email: 'dana@acme.com' }, { source: 'web form 8812' })
  assert.equal((await list.check({ email: 'dana@acme.com' })).allowed, false, 'an email cannot lift a STOP by text')
  advance(60_000)
  const r = await list.inbound('+14155550100', 'START', { channel: 'sms' })
  assert.equal(r.recorded, 'opted_in')
  assert.equal((await list.check({ email: 'dana@acme.com' })).allowed, true)
  advance(60_000)
  await list.inbound('dana@acme.com', 'unsubscribe me', { channel: 'email' })
  assert.equal((await list.check({ phone: '+14155550100' })).allowed, false, 'a later opt-out blocks again')
})

test('an opt-in at the same moment does not lift an opt-out', async () => {
  const { list } = setup()
  await list.optOut({ phone: '+14155550100' })
  await list.optIn({ phone: '+14155550100' }, { source: 'test' })
  assert.equal((await list.check({ phone: '+14155550100' })).allowed, false)
})

test('a wrong number blocks only that number, and links nothing', async () => {
  const { list } = setup()
  await list.link({ email: 'dana@acme.com', phone: '+14155550100' })
  const r = await list.inbound('+14155550100', 'wrong number, sorry', { channel: 'sms', also: { email: 'dana@acme.com' } })
  assert.equal(r.recorded, 'wrong_number')
  assert.equal((await list.check({ phone: '+14155550100' })).blocks[0].how, 'wrong_number')
  // The number was not hers, so it says nothing about whether Dana wants to hear from you.
  assert.equal((await list.check({ email: 'dana@acme.com' })).allowed, true)
  const { list: fresh } = setup()
  await fresh.inbound('+14155550100', 'wrong number', { also: { email: 'dana@acme.com' } })
  assert.equal((await fresh.check({ email: 'dana@acme.com' })).allowed, true, 'also is ignored for a wrong number')
})

test('nothing is recorded for an ordinary message', async () => {
  const { list, path } = setup()
  const r = await list.inbound('dana@acme.com', 'Can we move the call to 3pm?')
  assert.equal(r.recorded, 'nothing')
  assert.throws(() => readFileSync(path), /ENOENT/)
})

test('the file holds keys, never addresses, numbers or text', async () => {
  const { list, path } = setup()
  await list.inbound('+14155550100', 'please stop texting me', { channel: 'sms', also: { email: 'dana@acme.com', id: 'slack:U024' } })
  const text = readFileSync(path, 'utf8')
  for (const secret of ['dana', 'acme', '4155550100', 'U024', 'texting']) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), secret)
  const { events, check } = parseList(text)
  assert.equal(events.length, 1)
  assert.equal(events[0].keys.length, 3)
  assert.match(events[0].keys.join(' '), /^p:[0-9a-f]{32} e:[0-9a-f]{32} i:[0-9a-f]{32}$/)
  assert.match(String(check), /^[0-9a-f]{16}$/)
})

test('the wrong secret is refused, not treated as an empty list', async () => {
  const { list, path } = setup()
  await list.optOut({ email: 'dana@acme.com' })
  const other = openList(path, { secret: 'a-different-secret-0123456789-abcdefgh' })
  await assert.rejects(other.check({ email: 'dana@acme.com' }), (e) => e instanceof DncError && e.code === 'wrong_secret')
  assert.throws(() => openList(path, { secret: 'short' }), DncError)
})

test('torn lines are skipped; stats count without naming anyone', async () => {
  const { list, path, advance } = setup()
  await list.inbound('+14155550100', 'STOP', { also: { email: 'dana@acme.com' } })
  advance(1000)
  await list.optOut({ email: 'sam@shop.example' })
  advance(1000)
  await list.inbound('+12125550199', 'STOP')
  advance(1000)
  await list.inbound('+12125550199', 'START')
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"opt_out","at":`)
  const s = await list.stats()
  assert.deepEqual(s, {
    people: 2,
    identifiers: 4,
    blockedByType: { email: 2, phone: 1, id: 0 },
    optOuts: 3,
    optIns: 1,
    lastOptOut: '2026-10-16T14:00:02.000Z',
    skipped: 1,
  })
})

test('two writers at once both land', async () => {
  const { path } = setup()
  const a = openList(path, { secret: SECRET })
  const b = openList(path, { secret: SECRET })
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).optOut({ phone: `+1415555${String(1000 + i)}` })))
  const { events, skipped } = parseList(readFileSync(path, 'utf8'))
  assert.equal(events.length, 20)
  assert.equal(skipped, 0)
})

test('check report', async () => {
  const { list } = setup()
  await list.inbound('+14155550100', 'STOP', { channel: 'sms', source: 'twilio webhook', also: { email: 'dana@acme.com' } })
  const text = formatCheck(await list.check({ email: 'dana@acme.com' }))
  assert.match(text, /^BLOCK {2}Do not contact, on any channel\./)
  assert.match(text, /2026-10-16 14:00 UTC {2}a linked phone replied with a stop keyword {2}by sms {2}\(twilio webhook\)/)
  assert.match(formatCheck(await list.check({ email: 'sam@shop.example' })), /^ALLOW/)
})

// ---------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------

test('csv round trip', () => {
  const rows = [['name', 'note'], ['Lee, Dana', 'said "hi"\nthen left'], ['Sam', '']]
  assert.deepEqual(parseCsv(toCsv(rows)), rows)
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']])
})

test('filter splits a list into may contact, blocked, and could not check', async () => {
  const { list } = setup()
  await list.inbound('+14155550100', 'STOP', { also: { email: 'dana@acme.com' } })
  const csv = [
    'Name,Email,Mobile',
    'Dana,dana@acme.com,',
    'Dana again,,415-555-0100',
    'Sam,sam@shop.example,+12125550199',
    'Nobody,,',
    'Broken,not-an-email,',
  ].join('\n')
  const r = await filterCsv(csv, list)
  assert.deepEqual(r.kept.map((x) => x[0]), ['Sam'])
  assert.deepEqual(r.blocked.map((x) => x[0]), ['Dana', 'Dana again'])
  assert.deepEqual(r.unchecked.map((x) => x.row[0]), ['Nobody', 'Broken'])
  assert.deepEqual(r.columns, { email: [1], phone: [2] })
  await assert.rejects(filterCsv('a,b\n1,2', list), /no email or phone column/)
  await assert.rejects(filterCsv(csv, list, { email: ['nope'] }), /No column named nope/)
})

// ---------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------

/**
 * @param {import('../src/list.js').DncList} list
 * @param {object[]} requests
 * @returns {Promise<any[]>}
 */
async function mcp(list, requests) {
  const input = new PassThrough()
  const output = new PassThrough()
  /** @type {string[]} */
  const lines = []
  output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = serve({ list, input, output })
  for (const r of requests) input.write(`${JSON.stringify(r)}\n`)
  input.end()
  await done
  return lines.map((l) => JSON.parse(l))
}

test('mcp: record, then check, in order; no tool to opt anyone back in', async () => {
  const { list } = setup()
  const [init, tools, recorded, checked, bad, optout] = await mcp(list, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record_inbound', arguments: { from: '+14155550100', text: 'STOP', channel: 'sms', also_email: 'dana@acme.com' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_contact', arguments: { email: 'dana@acme.com' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_contact', arguments: { phone: '555' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'record_opt_out', arguments: { email: 'sam@shop.example', channel: 'phone', how: 'asked on call' } } },
  ])
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.match(init.result.instructions, /do not contact them, on that channel or any other/)
  assert.deepEqual(tools.result.tools.map((/** @type {any} */ t) => t.name), ['check_contact', 'record_inbound', 'record_opt_out'])
  assert.equal(recorded.result.structuredContent.recorded, 'opted_out')
  assert.equal(checked.result.structuredContent.allowed, false)
  assert.equal(checked.result.structuredContent.blocks[0].via, 'a linked phone')
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /^Could not check, so do not contact this person yet/)
  assert.equal(optout.result.structuredContent.recorded, 'opted_out')
  const sam = await list.check({ email: 'sam@shop.example' })
  assert.deepEqual(sam.blocks[0], { code: 'opted_out', at: '2026-10-16T14:00:00.000Z', via: 'this email', channel: 'phone', how: 'asked on call', source: 'agent' })
})

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } })
}

test('cli: inbound, check, optin, filter, stats and exit codes', () => {
  const dir = tmp()
  const env = { DNC_LIST: join(dir, 'dnc.jsonl'), DNC_SECRET: SECRET, DNC_DEFAULT_COUNTRY: '1' }
  let r = cli(['inbound', '--from', '415 555 0100', '--also', 'dana@acme.com', '--channel', 'sms', 'STOP'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Opted out: 415 555 0100 and 1 linked, on every channel\./)

  r = cli(['check', 'dana@acme.com'], env)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^BLOCK/)
  assert.equal(cli(['check', 'sam@shop.example'], env).status, 0)
  assert.equal(cli(['check', 'not-a-thing'], env).status, 2)
  assert.equal(cli(['check', 'dana@acme.com'], { ...env, DNC_SECRET: 'another-secret-0123456789-abcdefghijk' }).status, 2)

  assert.equal(cli(['optin', '+14155550100'], env).status, 2, 'optin needs proof')
  assert.equal(cli(['optin', '+14155550100', '--source', 'replied START'], env).status, 0)
  assert.equal(cli(['check', 'dana@acme.com'], env).status, 0)
  assert.equal(cli(['optout', 'dana@acme.com', '--how', 'form'], env).status, 0)

  const csv = join(dir, 'leads.csv')
  writeFileSync(csv, 'name,email,phone\nDana,dana@acme.com,\nSam,sam@shop.example,\nNo one,,\n')
  r = cli(['filter', csv, '--blocked', join(dir, 'blocked.csv')], env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'name,email,phone\nSam,sam@shop.example,\n')
  assert.match(r.stderr, /1 may be contacted, 1 blocked, 1 could not be checked/)
  assert.equal(readFileSync(join(dir, 'blocked.csv'), 'utf8'), 'name,email,phone\nDana,dana@acme.com,\n')

  r = cli(['stats', '--json'], env)
  assert.equal(JSON.parse(r.stdout).people, 1)
  assert.equal(cli(['check', 'x@y.com'], { DNC_SECRET: SECRET, DNC_LIST: '' }).status, 2)
  assert.ok(cli(['secret'], {}).stdout.trim().length >= 32)
  assert.ok(newSecret().length >= 32)
})
