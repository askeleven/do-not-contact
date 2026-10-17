# do-not-contact

![do-not-contact: one opt-out list for every channel](https://raw.githubusercontent.com/askeleven/do-not-contact/main/docs/social-preview.png)

**One do-not-contact list for every channel. A STOP by text blocks that person by email too.**

```bash
export DNC_LIST=dnc.jsonl DNC_SECRET=$(npx @askeleven/do-not-contact secret)

npx @askeleven/do-not-contact inbound --from +14155550100 --also dana@acme.com --channel sms "pls stop texting me"
npx @askeleven/do-not-contact check dana@acme.com
```

```
BLOCK  Do not contact, on any channel.

      2026-10-16 14:00 UTC  a linked phone asked to stop  by sms
```

Every channel keeps its own opt-out list. The SMS provider knows Dana texted STOP. The
email platform does not, so the follow-up goes out by email the next morning. A person
would remember that Dana asked to be left alone. An agent working through a lead list,
reaching for whichever channel answers, will not, unless something tells it.

do-not-contact is that something: one list, every channel. It reads inbound messages for
STOP, unsubscribe and "please remove me", remembers which addresses and numbers belong to
the same person, and answers one question before any message goes out: may I contact this
person? A library for your code, a CLI for your pipelines, and an MCP server for your
agents.

It stores keyed hashes, never an address, a number or a word of anyone's message. Zero
dependencies. No network.

---

## What it does

| Someone | What happens |
|---|---|
| **Texts STOP**, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE or OPT OUT | Blocked on every channel, with every identifier you know for them |
| **Writes "please remove me from your list"**, "stop texting me", "don't email me", "how do I unsubscribe" | Blocked on every channel |
| **Says "wrong number"** | That number is blocked. Whoever you thought it belonged to is not, because it was not theirs |
| **Texts START or UNSTOP** | The opt-out made from that number is lifted |
| **Opts out by text, then opts back in by email** | Still blocked. Opting back in has to come from where they opted out |
| **Asks on a call, in person, on a form** | `optout` records it, with how they asked |
| **Writes "don't call me before 9am"** or "don't stop sending updates" | Nothing. They did not ask to stop |

**One person, many identifiers.** Whenever you record an opt-out with more than one
identifier, or `link` them, they are joined. A check of any one of them finds the person,
and a block on any one blocks all of them. Linking never lifts a block; it only spreads one.

**Your own quoted message is not their opt-out.** "Reply STOP to opt out" in the quote under
their reply is ignored. Only what they wrote counts.

## What it does not do

**It does not send anything, or stop anything being sent.** It answers the question. Your
code, or your agent, has to ask it before every message, and listen.

**It does not know who someone is.** It links identifiers you give it together. It never
looks anyone up.

**It does not read every language.** The keywords and phrases are English. A message it does
not recognise records nothing; record those with `optout`.

**It is not legal advice.** The FCC's 2025 revocation rule treats stop, quit, end, revoke,
opt out, cancel and unsubscribe as valid ways to revoke consent to texts, and allows "any
reasonable means". CAN-SPAM requires honoring email opt-outs. This tool honors them
immediately, everywhere, which is stricter than either. Whether that is enough for you is
for your lawyer.

**It blocks transactional messages too.** An opt-out blocks everything, receipts and
appointment reminders included, until the person opts back in. If you must send those,
that is a decision for your code to make on purpose, not one the list makes for you.

---

## For agents: MCP server

```bash
claude mcp add do-not-contact -e DNC_SECRET=... -- npx -y @askeleven/do-not-contact mcp --list ~/dnc.jsonl
```

**Claude Desktop, Cursor, and other clients** that take a JSON config:

```json
{
  "mcpServers": {
    "do-not-contact": {
      "command": "npx",
      "args": ["-y", "@askeleven/do-not-contact", "mcp", "--list", "/path/to/dnc.jsonl"],
      "env": { "DNC_SECRET": "...", "DNC_DEFAULT_COUNTRY": "1" }
    }
  }
}
```

It serves three tools:

- `check_contact` with every email, phone and id the agent has for someone. A check that
  cannot run says "do not contact this person yet", never "allowed".
- `record_inbound` for every message the agent receives, with the sender and any other
  identifiers it knows for them.
- `record_opt_out` for when someone asks any other way.

The server tells the model to check before every message, call or invite; never to contact
a blocked person on any channel; and not to look for another address or number to reach
them.

**There is no tool to opt anyone back in.** An agent that could lift a block could talk
itself past one. Opting back in is for people, with the CLI or the library.

In a test run, Claude Haiku was given two inbound messages: "pls stop texting me" by SMS from
Dana, whose email was on file, and "Yes, send the quote over" from Sam. It recorded both,
checked both, and declined to email Dana: "The block covers every channel, so I won't email
dana@acme.com or any other address for her."

## CLI

```
do-not-contact check <identifier...>
do-not-contact inbound --from <identifier> [--also <identifier>]... <text|file|->
do-not-contact optout <identifier...> [--channel <name>] [--how <words>]
do-not-contact optin <identifier...> --source <proof>
do-not-contact link <identifier...>
do-not-contact filter <file.csv> [--blocked <file>] [--unchecked <file>]
do-not-contact stats
do-not-contact mcp
do-not-contact secret
```

`dnc` is the same command, shorter. An identifier is an email address, a phone number, or
`namespace:value` for anything else (`slack:U024BE7LH`, `crm:48213`).

`check` exits `0` when allowed, `1` when blocked, and `2` when it could not check. A `2` is
not permission. So it gates a send:

```bash
dnc check "$TO" && ./send "$TO" message.txt
```

`filter` checks a whole CSV. It finds the email and phone columns by name, writes the rows
you may contact to standard output, and leaves out rows it could not check: no contact
details, or ones it cannot read.

```
$ dnc filter leads.csv --blocked blocked.csv > leads-ok.csv
412 may be contacted, 9 blocked, 3 could not be checked (left out). Email columns: Email. Phone columns: Mobile.
```

`optin` needs `--source`: the proof they asked, such as a message id or a form submission.

## As a library

```js
import { openList } from '@askeleven/do-not-contact'

const dnc = openList('dnc.jsonl', { secret: process.env.DNC_SECRET, defaultCountry: '1' })

// Every inbound message, on every channel:
await dnc.inbound(sms.from, sms.body, { channel: 'sms', also: { email: lead.email } })

// Before every outbound message:
const { allowed, blocks } = await dnc.check({ email: lead.email, phone: lead.phone })
if (allowed) await mailer.send(message)
```

`check(contact)`, `checkMany(contacts)`, `inbound(from, text, { channel, also, source })`,
`optOut(contact, { channel, how, source })`, `optIn(contact, { source })`,
`link(contact)` and `stats()`. A contact is `{ email, phone, id }`, each a string or a
list. `detectOptOut(text)` is exported on its own: it returns `opt_out`, `opt_in`,
`wrong_number` or `none`, and the words that decided it.

Wire your providers' own opt-out events in too: an unsubscribe link, a spam complaint, a
carrier STOP your SMS provider handled itself. Each is an `optOut` with `how` set to
`unsubscribe_link`, `complaint` or whatever names it.

## The list

An append-only JSONL file. Each line is one opt-out, opt-in or link, written and synced to
disk before the call returns:

```json
{"type":"opt_out","at":"2026-10-16T14:00:00.000Z","keys":["p:6f1e...","e:a90c..."],"from":"p:6f1e...","channel":"sms","how":"phrase","source":"agent"}
```

**Keys, not addresses.** Each identifier is normalized, so `Dana+News@ACME.com` and
`dana@acme.com` are the same, and `(415) 555-0100` is `+14155550100`. Then it is stored as
an HMAC-SHA256 under your secret. Without the secret, a key cannot be turned back into an
address or a number, even by trying every phone number there is. So the list can be backed
up, shared between systems that hold the secret, and kept after someone asks you to erase
their data, which is what a do-not-contact list is for.

**Keep the secret.** The list is only as useful as the secret: lose it, and nothing on the
list can be checked again. Open a list with a different secret and it refuses, rather than
quietly finding no one on it.

**Normalizing blocks more, never less.** A "+tag" is dropped from every address, and dots
from Gmail addresses. On the rare server where `dana+a` and `dana+b` are different people,
both are blocked. For a list of people who asked you to stop, that is the safe error.

Numbers without a country code need `--country` (or `DNC_DEFAULT_COUNTRY`). Without one,
`check` refuses rather than guess, and `filter` leaves the row out.

## Privacy

Nothing leaves your machine. There is no network code. The list holds no addresses,
numbers or message text.

## Requirements

Node 20 or newer. No dependencies.

---

## Why we built it

[AskEleven](https://askeleven.com) runs AI employees that email and text candidates and
customers for small businesses, often the same person on more than one channel. When
someone says stop on one, they mean all of them. It works with
[send-guard](https://github.com/askeleven/send-guard) and
[sms-guard](https://github.com/askeleven/sms-guard), which check the message; this checks
the person.

## Contributing

Issues and pull requests welcome, especially:

- **Opt-outs it misses**, and **ordinary messages it mistakes for opt-outs**, with the text.
  These matter most.
- **Keywords and phrases** in other languages.
- **Providers' opt-out webhooks**: how to map them to `optOut`.

Run the tests with `npm test`. They use a fixed clock and temporary files.

## License

MIT. See [LICENSE](LICENSE).
