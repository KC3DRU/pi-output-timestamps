# pi-output-timestamps
Adds the current time when Pi begins to send back a message, code block, or other response.  It allows you to see how long ago a message came out from your Pi agent.

```
@ 14:22:07 ->

Cox PH is the workhorse here. Two notes:
- check proportional hazards with cox.zph()

@ 14:23:41 ->
$ grep -c deaths claims.csv
```

Prose blocks and command blocks both get stamped. The stamp is **display-only**: it never
enters the session file, the model context, or HTML exports.

## Install

From a git remote (repeat on each machine):

```bash
pi install git:github.com/<you>/pi-output-timestamps
```

From a local path, without copying:

```bash
pi install ~/pi-packages/pi-output-timestamps
```

Try it for one run without touching settings:

```bash
pi -e ~/pi-packages/pi-output-timestamps
```

Update an existing install:

```bash
pi update --extensions
```

Remove:

```bash
pi remove pi-output-timestamps
```

Installs land in `~/.pi/agent/settings.json` (personal scope), so the stamps apply to every
project on the machine and load regardless of project trust. Add `--local` to scope a
project instead.

## Requirements

| Pi version | Result |
|---|---|
| >= 1.0.1 | prose stamps **and** command stamps |
| 0.84.0 - 1.0.0 | prose stamps only; the command-block half switches itself off |
| < 0.84.0 | loads and does nothing |

`pi.registerMarkdownTransformer()` landed in 0.84.0 and `pi.registerToolRenderer()` in
1.0.1. Both registrations are feature-detected, so an older Pi degrades instead of failing
to load -- it does not disable the other half.

## Behaviour worth knowing

- **Time shown is when the block started appearing**, not when the turn finished. A
  3-minute tool chain stamps at its start.
- **Command stamps appear only in live sessions.** In a resumed or forked session
  replaying history, execution never "starts", so those blocks stay unstamped.
  Prose still stamps in resumed sessions, hydrated from the session file.
- **Thinking blocks and your own messages are not stamped.**
- **HTML exports are unaffected** -- Pi does not run display transformers there.
- **Duplicate installs are safe.** Two copies (e.g. a personal install plus a leftover
  project copy) still print one stamp per block, by design.

## Troubleshooting

Command stamps missing with no explanation is possible: the command-block path fails
 closed
rather than break the UI. Make it talk:

```bash
STAMP_DEBUG=1 pi
```

prints e.g. `[output-timestamps] command stamps unavailable: Error: Cannot find module
'@earendil-works/pi-tui'` at startup.

## Tests

```bash
npm test
```

29 tests, no dependencies. They stub `@earendil-works/pi-tui` through
`module.registerHooks()`, so no `node_modules` is needed.
