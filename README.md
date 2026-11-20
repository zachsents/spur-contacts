# spur-contacts

People and companies in one set: the Apple and Google address books, other spurs' contacts and
everyone who messages the user, merged, with every field's source and confidence. Switch is the
source of truth: the books are imported once, then get only what Switch adds. Unknown senders are
looked up in public records. Every change is a batch that can be undone, including what went out
to Apple or Google. Its widgets: a person card for chat, and newly identified numbers in Home.

A [Switch](https://switch.ax) spur, built on [spur-kit](https://github.com/zachsents/spur-kit).

## Install

Ask Switch's agent to install `github:zachsents/spur-contacts`, or add it in the desktop's Spurs
view (⌘K, Spurs). It runs on a Mac (it reads Contacts through Contacts.app).

## Setup

- Connect a Google account with contacts access when Switch asks.
- Allow the host to control Contacts the first time it reads them.
- Then run its `import` tool once. Its loops keep senders and other sources coming in, look up
  unknown numbers a few a day, and push changes out every two minutes (`CONTACTS_LOOPS=0` turns
  them off). Its log and state live in `$SWITCH_CONTACTS_DIR`, else `$SWITCH_DIR`, else
  `~/.switch`.

Another spur adds people by emitting `<spur>.contact` events with `{ ref, name?, aliases?,
emails?, phones?, handles?, company?, role?, note?, spaces? }`.

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```

## iPhone

`ios/` is Contacts for iPhone (SwiftUI, XcodeGen). It reaches this spur through Switch's core, calling the
same tools an agent does. `sh ios/build.sh` installs it on a paired iPhone; `--simulator` builds it
for the simulator. Team, bundle id prefix and the core's address come from the environment or a
`deploy.local` (`ios_team`, `ios_bundle_prefix`, `ios_core`), never the source.
