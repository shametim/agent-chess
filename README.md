# agent-chess

TypeScript CLI where two AI agents can play chess using join tickets.

Game state is file-backed (`~/.agent-chess-data/games/*.json`), so agents can submit moves from separate processes.

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm run dev -- --help
```

## Core commands

```bash
# Join game (creates one if none active), get side + ticket
npm run dev -- join <agentId>

# Submit one move with your ticket, then wait for opponent move
npm run dev -- play <ticketId> <move>

# Include thinking metadata
npm run dev -- play <ticketId> e2e4 --thinking "Claim center. Open lines and keep king safety options"

# Inspect state
npm run dev -- board
npm run dev -- history <gameId>
npm run dev -- list

# Live web monitor
npm run dev -- live <gameId> --poll-ms 1500

```

## Play behavior

- `play` submits exactly one move and then blocks while waiting for opponent progress.
- If it is not your turn yet, `play` blocks until your turn is available (or timeout).
- Timeout is fixed at 2 minutes.
- Exit code is `2` on timeout.
- On exit, `play` prints board state, game stats, and writes a step-by-step replay HTML file.
- On exit, `play` also prints a stable per-game live URL.
- `board` also writes/refreshes a replay HTML file for the selected game.
- `board` also prints/starts the same per-game live URL.
- The managed live URL process is detached and not auto-stopped when a game becomes inactive.
- `join` returns a ticket tied to your model id, game id, and side.
- Only one active game is allowed at a time; `join` reuses it instead of creating another.
- `join` blocks until both agents have joined and it is your turn.
- `play` uses ticket id only.

## JSON mode

Most commands support `--json` for machine-readable integration.

```bash
npm run dev -- play <ticketId> e2e4 --thinking "Claim center" --json
npm run dev -- history <gameId> --json
npm run dev -- list --json
```

## Agent usage rules

Use only this CLI while playing, and do not run background terminals/processes for gameplay.
Use direct CLI commands only; do not write scripts/wrappers/macros/aliases to automate gameplay.
Use your model identity as `agentId` in `join` (examples: `gpt-5.3`, `gemini-2.5-pro`).
Keep your `ticketId` from `join`; use it for every `play` command.
Always include `--thinking "<reasoning>"` in each `play` command so live UI can display your rationale.
Run one `play` move at a time and let it block; do not start a second session to play the opponent color yourself.
Agents are expected to choose and submit moves autonomously; do not ask the human for move decisions or gameplay input.

Recommended loop:

```bash
# open the live UI
npm run dev -- ui

# join to get your ticket
npm run dev -- join gpt-5.3@codex-app

# after opponent responds, submit your next move
npm run dev -- play <ticketId> g1f3 --thinking "Develop knight"
```
