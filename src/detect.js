/**
 * @typedef {'opt_out'|'opt_in'|'wrong_number'|'none'} DetectedKind
 *   opt_out: they asked to stop. opt_in: they asked to start again, by keyword.
 *   wrong_number: the number is not theirs, so nobody there agreed to hear from you.
 *
 * @typedef {object} Detection
 * @property {DetectedKind} kind
 * @property {'keyword'|'phrase'|null} how keyword: the whole message is a keyword such as
 *   STOP. phrase: a sentence in it says so.
 * @property {string | null} match The words that decided it.
 */

/**
 * Keywords that are an opt-out when they are the whole message. The FCC's 2025 rule names
 * stop, quit, end, revoke, opt out, cancel and unsubscribe; carriers add stopall.
 */
const OPT_OUT_KEYWORD = /^(?:stop|stop all|stopall|stop please|please stop|unsubscribe|cancel|end|quit|revoke|opt[- ]?out|remove|remove me|no more)[.!\s]*$/i

const OPT_IN_KEYWORD = /^(?:start|unstop)[.!\s]*$/i

const WRONG_NUMBER =
  /\b(?:wrong (?:number|person|phone)|(?:this|that) is(?:n't| not) (?:\w+(?:'s)? )?(?:number|phone)|you have the wrong (?:number|person)|(?:i|we) (?:am|are|'m|'re) not (?:\w+ ){0,2}(?:you(?:'re| are) looking for)|no one (?:by|with) that name)\b/i

const OPT_OUT_PHRASE = new RegExp(
  String.raw`\b(?:${[
    String.raw`(?<!(?:don't|do not|dont|never|not) )stop (?:texting|emailing|e-mailing|messaging|contacting|calling|sending|spamming)(?: (?:me|us|this number))?`,
    String.raw`(?<!(?:don't|do not|dont|never|not) )stop (?:these|your|the) (?:texts|messages|emails|e-mails|calls)`,
    String.raw`(?:remove|delete|take) (?:me|us|my (?:number|email|e-mail|details|info)) (?:from|off) (?:your|the|this|all|any|every) (?:\w+ ){0,2}(?:list|lists|database|system|records|contacts)`,
    String.raw`(?:remove|take) (?:me|us) (?:off|out)(?= *[.!]*$)`,
    String.raw`remove (?:me|us)(?= *[.!]*$)`,
    String.raw`(?:please )?unsubscribe (?:me|us)`,
    String.raw`(?:want|like|wish|need) to (?:unsubscribe|opt[- ]?out)`,
    String.raw`how (?:do|can) (?:i|we) (?:unsubscribe|opt[- ]?out|stop (?:these|this|your))`,
    String.raw`opt (?:me|us) out`,
    String.raw`(?:do not|don't|dont|never) (?:contact|email|e-mail|text|message|call|ring) (?:me|us|this number)(?! (?:before|after|until|till|at|on|during|between|in|today|tomorrow|tonight|this|next|while|when|again till))(?!,? (?:just |only |please |instead )?(?:text|txt|email|e-mail|message|call|ring|whatsapp))`,
    String.raw`(?:i|we) (?:do not|don't) want (?:any more|anymore|more|your) (?:texts|messages|emails|e-mails|calls)`,
    String.raw`no more (?:texts|messages|emails|e-mails|calls)`,
    String.raw`leave me alone`,
    String.raw`revoke (?:my )?consent`,
  ].join('|')})\b`,
  'i',
)

/**
 * Whether an inbound message asks to stop, to start again, or says it reached the wrong
 * person. Reads only what the sender wrote, not the quoted message under it, so your own
 * "Reply STOP to opt out" in the quote is not their opt-out. English only.
 *
 * @param {string} text
 * @returns {Detection}
 */
export function detectOptOut(text) {
  const body = stripQuoted(text).replace(/\s+/g, ' ').trim()
  if (!body) return { kind: 'none', how: null, match: null }
  if (OPT_OUT_KEYWORD.test(body)) return { kind: 'opt_out', how: 'keyword', match: body }
  if (OPT_IN_KEYWORD.test(body)) return { kind: 'opt_in', how: 'keyword', match: body }
  const wrong = WRONG_NUMBER.exec(body)
  if (wrong) return { kind: 'wrong_number', how: 'phrase', match: wrong[0] }
  const phrase = OPT_OUT_PHRASE.exec(body)
  if (phrase) return { kind: 'opt_out', how: 'phrase', match: phrase[0] }
  return { kind: 'none', how: null, match: null }
}

/**
 * The part of a message the sender wrote, without the quoted message under it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripQuoted(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  /** @type {string[]} */
  const kept = []
  for (const line of lines) {
    if (
      /^\s*On\b.{0,200}\bwrote:\s*$/i.test(line) ||
      /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) ||
      (/^\s*From:\s.+$/i.test(line) && kept.length > 0 && /^\s*$/.test(kept[kept.length - 1] ?? '')) ||
      /^\s*_{10,}\s*$/.test(line)
    ) {
      break
    }
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}
