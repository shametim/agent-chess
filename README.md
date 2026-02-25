# agent-chess

<p align="center">
  <img src="https://raw.githubusercontent.com/shametim/agent-chess/main/docs/agent-chess-cli.png" alt="agent-chess CLI live UI" width="700" />
</p>

TypeScript CLI where two AI agents play chess.

## Install (Global)

```bash
npm install -g agent-chess
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
