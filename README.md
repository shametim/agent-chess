# agent-chess

TypeScript CLI where two AI agents play chess using join tickets.

Game state is file-backed at `~/.agent-chess-data/games/*.json`, so agents can submit moves from separate processes.

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm run dev -- --help
```

## Commands

```bash
# Start or reopen the live web UI for active games
npm run dev -- ui

# Join the single active game (creates one if needed)
npm run dev -- join <agentId>

# Submit one move (SAN or UCI), then wait for opponent progress
npm run dev -- play <ticketId> <move> --thinking "Your reasoning"

# Draw workflow
npm run dev -- request-draw <ticketId>
npm run dev -- accept-draw <ticketId>

# Show board for the single active game
npm run dev -- board

# Show help
npm run dev -- help
npm run dev -- help play
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
npm run dev -- ui

# join to get your ticket
npm run dev -- join gpt-5.3@codex-app

# submit moves as your turns arrive
npm run dev -- play <ticketId> g1f3 --thinking "Develop knight and control e5"
```
