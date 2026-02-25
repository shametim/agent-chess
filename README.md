# agent-chess

TypeScript CLI where two AI agents play chess using join tickets.

Game state is file-backed at `~/.agent-chess-data/games/*.json`, so agents can submit moves from separate processes.

## Install (Global)

```bash
npm install -g agent-chess
```

## Run

```bash
agent-chess --help
```

## Commands

```bash
# Start or reopen the live web UI for active games
agent-chess ui

# Join the single active game (creates one if needed)
agent-chess join <agentId>

# Submit one move (SAN or UCI), then wait for opponent progress
agent-chess play <ticketId> <move> --thinking "Your reasoning"

# Draw workflow
agent-chess request-draw <ticketId>
agent-chess accept-draw <ticketId>

# Show board for the single active game
agent-chess board

# Show help
agent-chess help
agent-chess help play
```

## Play Behavior

- `join` blocks until both agents have joined and it is your turn.
- `join` returns a ticket tied to your game and side.
- `play` requires `--thinking` on every move.
- `play` submits exactly one move and then blocks waiting for opponent progress.
- If it is not your turn, `play` waits until your turn is available before submitting.
- If there is a pending draw request from the opponent, the first `play` call prints a draw prompt and exits; running `play` again continues play (implicit decline).
- Timeout is fixed at 2 minutes.
- Exit code is `2` on timeout.
- `ui` starts a local live web app and opens it in your browser.
- Only one active game is supported; `join` reuses it if it already exists.

## Development

```bash
npm install
npm run build
npm run dev -- --help
```

## Agent Usage Rules

Use only this CLI while playing.

- Use direct CLI commands only; do not write scripts, wrappers, macros, or aliases to automate gameplay.
- Do not run background terminals/processes for gameplay.
- Use your model identity + harness/environment for `agentId` in `join` (examples: `gpt-5.3@codex-app`, `gemini-2.5-pro@opencode-cli`).
- Keep your `ticketId` from `join`; use it for every `play`, `request-draw`, and `accept-draw` command.
- Always include `--thinking "<reasoning>"` in each `play` command so rationale is visible in live UI.
- Run one `play` move at a time and let it block; do not play the opponent color yourself.
- Agents must choose and submit moves autonomously; do not ask the human for move decisions.

Recommended loop:

```bash
# open live UI
agent-chess ui

# join to get your ticket
agent-chess join gpt-5.3@codex-app

# submit moves as your turns arrive
agent-chess play <ticketId> g1f3 --thinking "Develop knight and control e5"
```
