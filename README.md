# Telegram Claude Code Bridge

Drive Claude Code across a whole workspace of git repositories from Telegram. One running bot
works with all of them — apps, frontends, backends — and you pick the target with `/project`.

New here? Start with **[QUICKSTART.md](QUICKSTART.md)**. This file is the full reference.

- Requires **Node.js 18+** (20 LTS or later recommended) and the **Claude Code CLI** installed
  and authenticated. No API key — the bridge drives the CLI, which uses your local auth.
- Only you can use it: every handler checks the sender's Telegram user id.
- Works on macOS, Linux and Windows (see [Platform support](#platform-support)).

## Configuration

Copy `.env.example` to `.env` and fill it in. Only `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
and `WORKSPACE_ROOT` are required.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | Your user id — the only person the bot obeys, and where it sends restart notices |
| `WORKSPACE_ROOT` | yes | — | Absolute path of the folder scanned for projects — the only place scanned |
| `TELEGRAM_OWNER_ID` | no | `TELEGRAM_CHAT_ID` | Set only if your user id differs from your private chat id |
| `CLAUDE_CLI` | no | `~/.local/bin/claude` | Full path to the Claude CLI — set it for a non-default install or on Windows |
| `DEFAULT_PROJECT` | no | first project found | Project a fresh tab starts on (alias, name or substring) |
| `ALIASES` | no | — | Short names for projects, e.g. `api:my-backend,web:my-frontend` (comma-separated `alias:directory` pairs) |
| `CLAUDE_TIMEOUT_MS` | no | `600000` | How long a single Claude run may take before it's killed |
| `HANDOFF_IDLE_MS` | no | `60000` | Quiet time after which a tab lets go of its session; `0` disables |
| `SUMMARY_MODEL` | no | `claude-haiku-4-5-20251001` | Model that summarises a `/sessions` preview; `off` disables summaries |
| `SUMMARY_TIMEOUT_MS` | no | `60000` | How long that summary may take before it is abandoned |
| `SESSION_LIVE_WINDOW_MS` | no | `300000` | A transcript touched more recently than this counts as still open |
| `STATE_FILE` | no | `state.json` | Where per-tab project and conversation state is kept |
| `CLAUDE_PROJECTS_DIR` | no | `~/.claude/projects` | Where the CLI keeps its transcripts, read by `/sessions` |
| `MAX_ATTACHMENTS` | no | `5` | Files one reply may send |
| `FFMPEG_CLI` | no | `ffmpeg` | Transcodes videos so they play inline |
| `INBOX_DIR` | no | `inbox` | Where files you send the bot are stored |
| `INBOX_KEEP_DAYS` | no | `7` | How long inbox files survive |
| `PROGRESS_INTERVAL_MS` | no | `4000` | How often the live progress message is edited |
| `PROGRESS_MAX_LINES` | no | `20` | Steps shown in the progress message |
| `PROGRESS_LINE_CHARS` | no | `600` | Character budget per progress line |
| `LOG_FILE` | no | `bridge.log` | Where console output is mirrored |

### How projects are discovered

The bridge scans `WORKSPACE_ROOT` and nothing else. Every direct subdirectory of it that
contains a `.git` becomes a selectable project:

```
🗂️  Workspace: /Users/you/code
Discovered projects:
  backend
  admin-dashboard
  web-frontend
▸ mobile-app
  infra
```

Wherever the bridge itself lives — inside one of your projects or off on its own — makes no
difference; it scans the folder you name, never its own surroundings. `WORKSPACE_ROOT` is
required, so it never wanders into unrelated directories; without it the bridge refuses to
start rather than guess.

Names match by exact name first, then by case-insensitive substring — `/project front`
selects `web-frontend`. An ambiguous substring is reported instead of guessed. Define short
names with `ALIASES` and pick the startup project with `DEFAULT_PROJECT`.

## Running

There are two ways to run the bridge: **in the foreground**, tied to your terminal, or **as a
daemon** you can walk away from.

### Foreground (attached to the terminal)

```bash
npm start
```

The bridge runs in the current console and prints everything it does there live — every
request, tool call and answer. Stop it with Ctrl+C. Closing the terminal stops it too. This
is the mode for trying it out and watching what happens.

`npm run dev` is the same but restarts on every source edit — only for hacking on the bridge
itself, since a restart kills whatever Claude is doing mid-run and makes Telegram redeliver
the request.

### Daemon (detached)

```bash
npm run bg           # build, start detached, write bridge.pid
npm run bg:status    # running? for how long? any Claude run in flight?
npm run bg:restart   # pick up code changes
npm run bg:stop
npm run bg:log       # follow the log live
```

The bridge starts in the background and keeps running after you close the terminal — this is
the mode for everyday use. Output goes to `bridge.log` (and startup crashes to `bridge.out`)
rather than the console; watch it with `npm run bg:log` or `/log` from Telegram.

`npm run bg` works on every OS — it runs `bridge.mjs`, a small Node process manager. Outside
npm (a systemd unit, a launchd plist), call it directly: `node bridge.mjs start|stop|status`.

`stop` sends SIGTERM first so Telegraf can close its long poll, escalating only if the process
hangs. `bg:status` also reports a `claude` run in flight (macOS/Linux) — restarting then would
kill it. `npm run bg` rebuilds `dist/` every time, so a start always picks up current source.

### Platform support

Runs on macOS, Linux and Windows. Windows caveats:

- **`CLAUDE_CLI` is a full path**, defaulting to `~/.local/bin/claude` (the native-installer
  location on macOS and Linux). On Windows, or for any other install, set it in `.env` — see
  the per-OS examples in `.env.example`. A `.cmd` target is launched through a shell, where a
  prompt with metacharacters (`&`, `|`, `"`, `%`) can be re-parsed by `cmd.exe`; a path to a
  real `.exe` avoids that.
- **`/sessions` and `/delete`** read the CLI's history under `~/.claude/projects` using the
  same folder-naming scheme the CLI uses — verified on macOS/Linux, expected but not verified
  on Windows.
- Everything else is plain Node and platform-independent.

## Usage

Send any request as text and it runs against the currently selected project:

- "add logging to lib/services/auth.dart"
- "run the tests and show the results"
- "which files are in lib/view?"

Claude reads files, edits code, runs commands, and sends the results back.

### Commands

| Command | Effect |
| --- | --- |
| `/projects` | List discovered projects, marking the current one |
| `/project [<name>]` | Show the current project, or switch to another |
| `/status` | Bridge health, current project, current conversation, mode |
| `/mode [<mode>]` | Show or set the Claude permission mode for this tab |
| `/cancel` | Stop the run in flight for this tab |
| `/sessions [n\|text]` | Pick up a conversation as buttons — VS Code ones included |
| `/delete [n\|text]` | Delete a conversation from disk — asks to confirm first |
| `/clear` | Start a fresh conversation for the current project |
| `/log [n]` | Last `n` log lines (default 25, max 100) |
| `/help` | List the commands |

The list is registered with Telegram on startup, so typing `/` autocompletes. It is written
to the chat scope (which wins over a shared bot's `all_private_chats` menu) as well as the
default scope. If the menu looks stale after a restart, reopen the chat — the client caches it.

### Permission mode

`/mode` sets how Claude treats permissions in the current tab, passed straight to the CLI:

- `default` — asks as usual
- `plan` — works out a plan without making changes
- `acceptEdits` — applies edits without asking
- `bypassPermissions` — runs everything unprompted (use with care)

It is per tab, remembered in `state.json`, and applies from your next message. `/status` shows
it when it is not the default.

### Cancelling a run

`/cancel` stops the Claude run in flight for the current tab — the child process is killed and
the reply comes back as `🛑 Cancelled` instead of an answer. Anything queued behind it then
proceeds; send `/cancel` again to stop the next one.

### Live progress

A request answers with one message that is edited as the run unfolds, so a long task shows
what it is doing instead of looking hung:

```
⏳ backend — 5 step(s)
🔧 Bash: npm test
💬 Running the suite now
🔧 Read: playwright.config.ts
```

Driven by `--output-format stream-json`, throttled to `PROGRESS_INTERVAL_MS`, one message per
run (Telegram rate-limits bots). When the answer is ready the feed is deleted, leaving the
question and the answer; the full step list stays in `bridge.log`.

### Files

**Receiving.** Send a photo or any file and it becomes part of the request: it is saved to
`inbox/` and its path goes into the prompt, so Claude opens it with its own Read tool. A
caption is the question; without one the bridge asks Claude to describe the file. Telegram
caps bot downloads at 20 MB. Inbox files are pruned after `INBOX_KEEP_DAYS`.

**Sending.** Claude returns files by naming them on a line of its own at the end of a reply:

```
SEND: test-results/…/test-failed-1.png | the grid was empty
```

The bridge uploads what the line points at, picking `sendPhoto`/`sendVideo`/`sendDocument`
by extension (webm is transcoded to mp4 so it plays inline). The path must resolve inside
`WORKSPACE_ROOT`, be under 50 MB, and there are at most `MAX_ATTACHMENTS` per reply.

## Tabs

The private chat is one workspace. To get more — a column of tabs, each its own project or its
own conversation — turn the bot's chat into a **Telegram forum group with Topics**, where every
topic is a tab: its own selected project, its own Claude conversation, its own progress feed.
It is like having several Claude Code tabs open at once.

### Setting it up

1. Create a Telegram **group** (a group, not a channel) and add the bot.
2. Open the group's settings and turn **Topics** on.
3. Make the bot an **admin** — or message [@BotFather](https://t.me/BotFather),
   `/setprivacy` → **Disable**. Without one of these a bot in a group only sees messages that
   start with `/`, so plain requests would be ignored.
4. Create a topic per tab and run `/project <name>` in each to point it somewhere.

That's it. Each topic now remembers its own project across restarts (kept in `state.json`). A
topic where you never ran `/project` falls back to `DEFAULT_PROJECT`, and `/status` /
`/sessions` say so, so you are not left wondering why two topics show the same thing.

### What a tab can point at

Each topic points at a project independently, so you are free to mix:

- **A tab per project** — different repositories in different topics, e.g. "Mobile app",
  "Web frontend", "Backend".
- **Several tabs on one project** — two topics on the *same* repository to keep two separate
  conversations about it, say one refactoring and one chasing a bug, each with its own history
  via `/sessions`.

Nothing stops you combining them: two topics on `mobile-app` **and** a third on `backend` is a
perfectly normal setup. Just run `/project` in each accordingly.

The only rule is about **concurrency, and it is per project**. Runs on *different* projects go
in parallel — the `backend` tab works while a `mobile-app` tab is busy. Two tabs on the
*same* project take **turns**: two Claude runs editing one working copy at once produce
conflicting edits, so the bridge queues them behind each other.

## Conversations

Each tab+project keeps its own Claude CLI **session**, resumed on every request
(`claude --resume <id>`), so Claude remembers the whole conversation and manages its own
context. State lives in `STATE_FILE` and survives restarts. `/clear` starts a fresh one.

### Picking up a conversation

The CLI stores every session of a project in one directory keyed by the working directory
alone, so a conversation you started in **VS Code** or a terminal is visible here too.
`/sessions` lists them as buttons (titled by the CLI's own name for each), newest first, with
a ➕ **New conversation** button on top:

```
💬 Recent conversations in mobile-app — from any window
▸ this tab is on: Fix pull-to-refresh (a1b2c3d4…)
🔴 written to just now, so probably still open elsewhere

[ ➕ New conversation ]
[ 🔴 1. Fix pull-to-refresh · 1m ago ]     [ 👁 ]
[ 2. Refactor auth flow · 4h ago ]         [ 👁 ]
```

Tap a row to continue that conversation — the same session, no copy. `/sessions 20` reaches
further back; `/sessions <text>` searches titles. The header names what the tab is on even
when it is older than the list.

**👁 reads one first.** It shows the last few messages plus a one-line summary (written by a
separate, tool-less Haiku run that never touches the session it describes), so you can tell
what a conversation was about before committing to it.

**🔴 means live.** A transcript written to within `SESSION_LIVE_WINDOW_MS` is probably open in
another window; tapping it asks to confirm, and only then is it **forked** (`--fork-session`)
so that window keeps its work. Every other pick just continues the session. Two processes
resuming one transcript both succeed but grow separate branches, and the next resume follows
only one — hence the fork for the one case where it matters.

### Handing off to the desk

The bridge resumes per message, so a tab quiet for `HANDOFF_IDLE_MS` (one minute, timed from
the bridge's last reply) is not using its session, only claiming it. So it lets go: after the
idle window the session is free to open at your desk, and your next Telegram message simply
takes it back — the same session, continued, not a copy. `/status` shows where a tab is in
that cycle. If the transcript changed while parked (you worked on it at the desk), the next
run says so, because from then on both windows share one transcript.

Going the other way, sessions the bridge starts show up in VS Code's own `/resume` picker —
they live in the same directory.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test over test/*.test.ts (no framework, uses tsx)
```

Both run in CI (`.github/workflows/ci.yml`) on push and pull request.

## Security

- Only you can use the bot — the sender's user id is checked on every handler.
- Uses Claude Code's local authentication; no API key, no secrets sent to the cloud.
- Each request runs with `cwd` set to the selected project.
- The CLI is invoked with an argument array, so message text is not parsed by a shell (except
  a `.cmd` CLI target on Windows — see Platform support).
- The selectable set is every git repo under `WORKSPACE_ROOT` — narrow it for a smaller blast
  radius. `/delete` removes a transcript from disk permanently, behind a confirmation.

## Logs

Everything the bridge prints is mirrored to `bridge.log` (override with `LOG_FILE`), with an
ISO timestamp per line, surviving restarts.

```bash
tail -f bridge.log      # follow live   (or: npm run bg:log)
grep '❌' bridge.log     # every failure
```

`/log 50` returns the last 50 lines over Telegram. The log is gitignored but contains your
requests and Claude's answers — treat it like the transcript it is.

## Troubleshooting

**The bot does not respond**
- Check `.env` exists and is filled in; verify the token with @BotFather; check the console.

**The bridge exits at startup with "WORKSPACE_ROOT is not set"**
- It is required — set it to the absolute path of the folder holding your repositories.

**"No git repositories found under WORKSPACE_ROOT=…"**
- The path is set but has no git repos directly inside it. Point it one level up/down.

**A project is missing from `/projects`**
- It must be a *direct* subdirectory of `WORKSPACE_ROOT` and contain a `.git`. Check the
  `🗂️  Workspace:` line at startup.

**Every request fails with "this workspace was never trusted"**
- The CLI drops all permissions in an untrusted directory. Run `claude` once in that project
  and accept the trust prompt (trust is per project).

**The process exited on a long request**
- A run can take minutes; the bridge disables Telegraf's 90s watchdog and enforces its own
  `CLAUDE_TIMEOUT_MS`. Raise it if Claude itself is being cut off.

**"can't parse entities" instead of the answer**
- Telegram's Markdown is stricter than Claude's; the bridge retries such a chunk as plain
  text, so the answer still arrives, just unformatted.

## Architecture

```
Telegram  ──messages──▶  Bridge (Node / Telegraf, long polling)
                          - project registry, tabs, per-project state
                          - spawn(claude, ['-p', …]), cwd = selected project
                                     │
                                     ▼
                          Claude Code CLI  (reads/edits files, runs commands,
                                            project CLAUDE.md and skills)
```
