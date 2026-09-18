# Quick start

Get the bridge talking to Claude Code in five steps. Full reference is in [README.md](README.md).

## Prerequisites

- **Node.js 18 or newer** (20 LTS or later recommended). `node -v` to check; npm ships with it.
- **The Claude Code CLI**, installed and authenticated — `claude` must work in your terminal.
- A Telegram account.

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather), run `/newbot`, name it, and save the **token**.

### 2. Find your chat id

Send your new bot any message, open
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`, and copy the `"id"` from the response.

### 3. Install

```bash
cd bridge
npm install
```

The Claude Code CLI must already be installed and working (`claude` in your terminal).

### 4. Configure

```bash
cp .env.example .env
```

Fill in the three values that matter:

```env
TELEGRAM_BOT_TOKEN=...        # from step 1
TELEGRAM_CHAT_ID=...          # from step 2
WORKSPACE_ROOT=/absolute/path/to/your/code   # the folder holding your repositories
```

`WORKSPACE_ROOT` is required — it is the only folder scanned, and every direct subdirectory
with a `.git` becomes a selectable project. `CLAUDE_CLI` defaults to `~/.local/bin/claude`;
set it only if yours lives elsewhere (or on Windows — see `.env.example`).

### 5. Run

Two ways, both fine:

```bash
npm start           # foreground: logs to this console, stops on Ctrl+C or when you close it
npm run bg          # daemon: keeps running after you close the terminal
```

Start with `npm start` to watch it work; switch to `npm run bg` once you trust it. The
daemon is managed with `npm run bg:status` / `bg:stop` / `bg:restart` / `bg:log`, and works on
every OS.

Now message the bot: `/projects` to see what it found, `/project <name>` to pick one, then
just type what you want done. That's it — see [README.md](README.md) for tabs, sessions,
file handling, and everything else.
