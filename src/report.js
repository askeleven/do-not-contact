/**
 * @typedef {import('./list.js').CheckResult} CheckResult
 * @typedef {import('./list.js').Stats} Stats
 */

const COLOURS = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m' }

const HOW = /** @type {Record<string, string>} */ ({
  keyword: 'replied with a stop keyword',
  phrase: 'asked to stop',
  wrong_number: 'said it was the wrong number',
  manual: 'recorded by hand',
  unsubscribe_link: 'used an unsubscribe link',
  complaint: 'marked a message as spam',
})

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {CheckResult} result
 * @param {{ colour?: boolean }} [options]
 * @returns {string}
 */
export function formatCheck(result, { colour = false } = {}) {
  const paint = painter(colour)
  if (result.allowed) {
    const linked = result.linked > 1 ? ` ${result.linked} linked identifiers checked.` : ''
    return `${paint(COLOURS.bold + COLOURS.green, 'ALLOW')}  ${paint(COLOURS.bold, 'Not on the list.')}${linked}\n`
  }
  const lines = [`${paint(COLOURS.bold + COLOURS.red, 'BLOCK')}  ${paint(COLOURS.bold, 'Do not contact, on any channel.')}`, '']
  for (const b of result.blocks) {
    const how = b.how ? (HOW[b.how] ?? b.how) : 'opted out'
    const parts = [`${b.at.slice(0, 16).replace('T', ' ')} UTC`, `${b.via} ${how}`]
    if (b.channel) parts.push(`by ${b.channel}`)
    if (b.source) parts.push(`(${b.source})`)
    lines.push(`      ${parts.join('  ')}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * @param {Stats} s
 * @returns {string}
 */
export function formatStats(s) {
  return (
    `${s.people} ${s.people === 1 ? 'person' : 'people'} blocked: ` +
    `${s.blockedByType.email} emails, ${s.blockedByType.phone} phone numbers, ${s.blockedByType.id} other ids.\n` +
    `${s.optOuts} opt-outs and ${s.optIns} opt-ins recorded, ${s.identifiers} identifiers in all.` +
    `${s.lastOptOut ? ` Last opt-out ${s.lastOptOut.slice(0, 16).replace('T', ' ')} UTC.` : ''}` +
    `${s.skipped ? ` ${s.skipped} unreadable lines skipped.` : ''}\n`
  )
}
