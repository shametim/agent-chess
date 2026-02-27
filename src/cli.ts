#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  abandonJoinTicketIfUnpaired,
  acceptDraw,
  createGame,
  gatePlayForPendingDraw,
  getGame,
  joinGame,
  makeMove,
  requestDraw,
  turnToSide,
} from "./chess-service.js";
import { renderGameBoard } from "./board-render.js";
import { startLiveViewServer } from "./live-view.js";
import { CliError, createStore, ensureStore, listGames, loadTicket } from "./storage.js";
import type { GameRecord, Side, TicketRecord } from "./types.js";

const program = new Command();
const PLAY_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const PLAY_POLL_INTERVAL_MS = 2000;
const DEFAULT_START_PORT = 41731;
const LIVE_SERVER_STATE_FILE = "live-server.json";

type PlayWaitState = "opponent-moved" | "game-finished" | "timeout";
type PreMoveWaitState = "ready" | "game-finished" | "timeout";

interface PlayWaitResult {
  state: PlayWaitState;
  game: GameRecord;
  polls: number;
  waitedMs: number;
}

interface PreMoveWaitResult {
  state: PreMoveWaitState;
  game: GameRecord;
  polls: number;
  waitedMs: number;
}

interface LiveServerState {
  pid: number;
  url: string;
  host: string;
  port: number;
}

function parseSide(value: string): Side {
  const normalized = value.trim().toLowerCase();
  if (normalized === "white" || normalized === "black") {
    return normalized;
  }
  throw new CliError(`Invalid side '${value}'. Use white or black.`);
}

function parseNonNegativeInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new CliError(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function output(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(String(data));
}

function formatSeat(side: Side, agent: string | null): string {
  return `${side}: status: ${agent ? "taken" : "free"} model name: ${agent ?? "n/a"}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function gameSummary(game: GameRecord): string {
  const turnSide = turnToSide(game.turn);
  const turnAgent = game.playerModels[turnSide];
  const lines = [
    `Game: ${game.id}`,
    `Status: ${game.status}`,
    formatSeat("white", game.playerModels.white),
    formatSeat("black", game.playerModels.black),
  ];
  if (game.status === "active") {
    lines.push(`Turn: ${turnSide}${turnAgent ? ` (${turnAgent})` : " (open seat)"}`);
    if (game.drawRequest) {
      lines.push(`Pending draw offer: from ${game.drawRequest.requestedBySide}`);
    }
  }
  if (game.winner) {
    lines.push(`Winner: ${game.winner}`);
  }
  if (game.resultText) {
    lines.push(`Result: ${game.resultText}`);
  }
  lines.push(`Moves: ${game.history.length}`);
  return lines.join("\n");
}

function formatDurationMs(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (safe >= 60000) {
    return `${(safe / 60000).toFixed(2)}m`;
  }
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(2)}s`;
  }
  return `${Math.round(safe)}ms`;
}

function formatHumanTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString();
}

function liveServerStatePath(): string {
  return path.join(store.dataDir, LIVE_SERVER_STATE_FILE);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function readLiveServerState(): Promise<LiveServerState | null> {
  const target = liveServerStatePath();
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LiveServerState>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.url === "string" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number"
    ) {
      return {
        pid: parsed.pid,
        url: parsed.url,
        host: parsed.host,
        port: parsed.port,
      };
    }
  } catch {
    // Ignore invalid state files.
  }
  return null;
}

async function clearLiveServerState(): Promise<void> {
  await rm(liveServerStatePath(), { force: true });
}

function clearLiveServerStateSync(): void {
  try {
    rmSync(liveServerStatePath(), { force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

async function getRunningLiveServerState(): Promise<LiveServerState | null> {
  const state = await readLiveServerState();
  if (!state) {
    return null;
  }
  if (isProcessAlive(state.pid)) {
    return state;
  }
  await clearLiveServerState();
  return null;
}

async function writeLiveServerState(state: LiveServerState): Promise<void> {
  await mkdir(store.dataDir, { recursive: true });
  await writeFile(liveServerStatePath(), JSON.stringify(state, null, 2), "utf8");
}

async function loadActiveGames(): Promise<GameRecord[]> {
  const persistedGames = await listGames(store);
  const allGames = await Promise.all(
    persistedGames.map(async (game) => {
      try {
        return await getGame(store, game.id);
      } catch {
        return game;
      }
    }),
  );
  return allGames.filter((game) => game.status === "active");
}

async function requireSingleActiveGame(): Promise<GameRecord> {
  const activeGames = await loadActiveGames();
  if (activeGames.length === 0) {
    throw new CliError("No active game found.");
  }
  if (activeGames.length > 1) {
    throw new CliError("Multiple active games found. Use an explicit <gameId> with agent-chess play.");
  }
  return activeGames[0];
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pickDefaultLiveGame(games: GameRecord[]): GameRecord | null {
  if (games.length === 0) {
    return null;
  }
  return [...games].sort((a, b) => {
    const updatedDiff = parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return parseTimestampMs(b.createdAt) - parseTimestampMs(a.createdAt);
  })[0];
}

function renderActiveGamesForHelp(games: GameRecord[]): string {
  if (games.length === 0) {
    return "Active games:\n  none";
  }
  const lines = ["Active games:"];
  for (const game of games) {
    const participants = [game.playerModels.white, game.playerModels.black].filter(
      (value): value is string => Boolean(value),
    );
    lines.push(
      `  - ${game.id} | modelIds=${participants.length > 0 ? participants.join(" vs ") : "none"} | turnModelId=${game.playerModels[turnToSide(game.turn)] ?? "open"} | updated=${formatHumanTime(game.updatedAt)}`,
    );
  }
  return lines.join("\n");
}

function openTargetInBrowser(target: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    const child = spawn("open", [target], { stdio: "ignore", detached: true });
    child.unref();
    return;
  }
  if (platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", target], { stdio: "ignore", detached: true });
    child.unref();
    return;
  }
  const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
  child.unref();
}

async function resolveJoinTargetGame(): Promise<GameRecord> {
  const activeGames = await loadActiveGames();
  if (activeGames.length === 0) {
    return createGame(store);
  }
  if (activeGames.length > 1) {
    throw new CliError("Multiple active games found. Finish one game before joining.");
  }
  return activeGames[0];
}

async function resolveTicketForPlay(ticketId: string): Promise<TicketRecord> {
  const ticket = await loadTicket(store, ticketId);
  const game = await getGame(store, ticket.gameId);
  const seatTicket = game.players[ticket.side];
  if (seatTicket !== ticket.ticketId) {
    throw new CliError(
      `Ticket ${ticket.ticketId} is no longer valid for ${ticket.side}. Expected ${ticket.ticketId}, found ${seatTicket ?? "open seat"}.`,
    );
  }
  return ticket;
}

async function waitForTurnToSubmit(ticket: TicketRecord): Promise<PreMoveWaitResult> {
  const startedAt = Date.now();
  let polls = 0;

  while (true) {
    const game = await getGame(store, ticket.gameId);
    const waitedMs = Date.now() - startedAt;

    if (game.status !== "active") {
      return { state: "game-finished", game, polls, waitedMs };
    }

    const seatTicket = game.players[ticket.side];
    if (seatTicket !== ticket.ticketId) {
      throw new CliError(
        `Ticket ${ticket.ticketId} is no longer valid for ${ticket.side}. Expected ${ticket.ticketId}, found ${seatTicket ?? "open seat"}.`,
      );
    }

    const turnSide = turnToSide(game.turn);
    if (turnSide === ticket.side) {
      return { state: "ready", game, polls, waitedMs };
    }

    if (waitedMs >= PLAY_WAIT_TIMEOUT_MS) {
      return { state: "timeout", game, polls, waitedMs };
    }

    polls += 1;
    await sleep(PLAY_POLL_INTERVAL_MS);
  }
}

async function waitForOpponentMove(gameId: string, ticketId: string, moveCountAfterSubmit: number): Promise<PlayWaitResult> {
  const startedAt = Date.now();
  let polls = 0;

  while (true) {
    const game = await getGame(store, gameId);
    const waitedMs = Date.now() - startedAt;

    if (game.status !== "active") {
      return {
        state: "game-finished",
        game,
        polls,
        waitedMs,
      };
    }

    if (game.history.length > moveCountAfterSubmit) {
      const lastMove = game.history[game.history.length - 1];
      if (lastMove && lastMove.by !== ticketId) {
        return {
          state: "opponent-moved",
          game,
          polls,
          waitedMs,
        };
      }
    }

    if (waitedMs >= PLAY_WAIT_TIMEOUT_MS) {
      return {
        state: "timeout",
        game,
        polls,
        waitedMs,
      };
    }

    polls += 1;
    await sleep(PLAY_POLL_INTERVAL_MS);
  }
}

function renderPlayResult(
  game: GameRecord,
  board: string,
  waitState: PlayWaitState,
  waitedMs: number,
  polls: number,
  side: Side,
): string {
  const lines: string[] = [];

  lines.push(board, "");
  lines.push("Tip: run `agent-chess ui` in a new terminal to watch the game live in your browser.", "");

  lines.push(`Seat: ${side}`);

  lines.push(`Wait state: ${waitState}`);
  lines.push(`Waited: ${formatDurationMs(waitedMs)} (polls=${polls}, timeout=${formatDurationMs(PLAY_WAIT_TIMEOUT_MS)})`);
  lines.push("", gameSummary(game));

  const lastMove = game.history[game.history.length - 1];
  if (lastMove) {
    lines.push("", `Last move: ${lastMove.san} by ${lastMove.by}`);
  }

  lines.push("", "Note to agent: Play the next move until game is over.");

  return lines.join("\n");
}

function renderDrawRequestPlayPrompt(ticketId: string, requestedAt: string): string {
  const lines = [
    `The other agent requested a draw at ${formatHumanTime(requestedAt)}.`,
    `Run \`agent-chess accept-draw ${ticketId}\` to accept the draw.`,
    "Or run your same `agent-chess play ...` command again to keep playing.",
  ];
  return lines.join("\n");
}

const store = createStore();

program
  .name("agent-chess")
  .description("CLI chess engine for AI agents.")
  .version("0.1.0");
program.addHelpCommand(false);

program.addHelpText(
  "after",
  `
Agent usage rules:
  - Use direct CLI commands only. Do not write scripts, wrappers, aliases, macros, or other code to automate gameplay.
  - Do not run background terminals/processes for game play.
  - Join first with your model identity + harness/environment (examples: gpt-5.3@codex-app, gemini-2.5-pro@opencode-cli).
  - Keep the returned ticket id; play uses only ticket id + move.
  - Always pass --thinking "<your reasoning>" on every play command.
  - Use play for turn-taking: each call submits one move, then waits (up to 2 minutes) for the opponent move.
  - Do not start a second session to play the opponent side yourself; stay blocked and wait for another agent to advance the game.
  - Agents must choose and submit their own chess moves. Do not ask the human for move suggestions or gameplay input.

How to play:
  # join game (creates one if needed)
  agent-chess join gpt-5.3@codex-app

  # submit each move with your ticket:
  agent-chess play <ticketId> g1f3 --thinking "Develop knight and control e5"

  # offer or accept a draw:
  agent-chess request-draw <ticketId>
  agent-chess accept-draw <ticketId>
`,
);

program
  .command("ui")
  .description("Start a local live web app that follows active game state.")
  .helpOption(false)
  .action(async () => {
    const running = await getRunningLiveServerState();
    if (running) {
      output(`Live view already running at ${running.url} (port ${running.port}).`, false);
      return;
    }

    const host = process.env.HOST ?? "127.0.0.1";
    const port = parseNonNegativeInt(process.env.PORT ?? `${DEFAULT_START_PORT}`, "port");
    const pollMs = parseNonNegativeInt("1500", "poll-ms");
    let selectedGameId: string | undefined;
    if (!selectedGameId) {
      const defaultLiveGame = pickDefaultLiveGame(await loadActiveGames());
      if (defaultLiveGame) {
        selectedGameId = defaultLiveGame.id;
      }
    }
    const live = await startLiveViewServer(store, {
      gameId: selectedGameId,
      host,
      port,
      pollMs,
      exitOnInactive: false,
    });
    await writeLiveServerState({
      pid: process.pid,
      url: live.url,
      host,
      port,
    });
    process.once("exit", () => {
      clearLiveServerStateSync();
    });
    process.once("SIGINT", () => {
      clearLiveServerStateSync();
    });
    process.once("SIGTERM", () => {
      clearLiveServerStateSync();
    });
    openTargetInBrowser(live.url);
    output(`Live view running: ${live.url}\nPress Ctrl+C to stop.`, false);
  });

program
  .command("reset")
  .description("Reset all game state (deletes all games, tickets, and live server state).")
  .helpOption(false)
  .action(async () => {
    await ensureStore(store);
    const gameFiles = await readdir(store.gamesDir);
    const ticketFiles = await readdir(store.ticketsDir);
    await Promise.all([
      ...gameFiles.map((f) => rm(path.join(store.gamesDir, f), { force: true })),
      ...ticketFiles.map((f) => rm(path.join(store.ticketsDir, f), { force: true })),
      clearLiveServerState(),
    ]);
    output(`Reset complete. Deleted ${gameFiles.length} game(s) and ${ticketFiles.length} ticket(s).`, false);
  });

program
  .command("join")
  .description("Join the single active game (or create one), then block until both agents are present and it is your turn.")
  .argument("<agentId>", "Agent ID (model identity + harness, e.g. gpt-5.3@codex-app)")
  .helpOption(false)
  .action(async (agentId: string) => {
    const targetGame = await resolveJoinTargetGame();
    const joined = await joinGame(store, targetGame.id, agentId, undefined);
    console.log(`Joined game ${joined.game.id} as ${joined.side}. Ticket: ${joined.ticket}`);
    console.log("Tip for humans: use `agent-chess ui` to see this game live in your browser");
    console.log("Waiting for another agent to join...");

    const ticket = await loadTicket(store, joined.ticket);
    let shouldReleaseOnExit = true;
    let releasing = false;
    const releaseIfNeeded = async (): Promise<void> => {
      if (!shouldReleaseOnExit || releasing) {
        return;
      }
      releasing = true;
      await abandonJoinTicketIfUnpaired(store, ticket.ticketId);
    };
    const onSigint = (): void => {
      console.log("\nInterrupted. Releasing seat...");
      void (async () => {
        await releaseIfNeeded();
        process.exit(130);
      })();
    };
    const onSigterm = (): void => {
      console.log("\nTerminating. Releasing seat...");
      void (async () => {
        await releaseIfNeeded();
        process.exit(143);
      })();
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    let announcedOpponentMoveWait = false;
    try {
      while (true) {
        const game = await getGame(store, ticket.gameId);
        if (game.status !== "active") {
          output(gameSummary(game), false);
          return;
        }

        const seatTicket = game.players[ticket.side];
        if (seatTicket !== ticket.ticketId) {
          throw new CliError(
            `Ticket ${ticket.ticketId} is no longer valid for ${ticket.side}. Expected ${ticket.ticketId}, found ${seatTicket ?? "open seat"}.`,
          );
        }

        const hasOpponent = ticket.side === "white" ? Boolean(game.players.black) : Boolean(game.players.white);
        if (!hasOpponent) {
          await sleep(PLAY_POLL_INTERVAL_MS);
          continue;
        }

        const turnSide = turnToSide(game.turn);
        if (turnSide !== ticket.side) {
          if (!announcedOpponentMoveWait) {
            console.log("Opponent joined. Waiting for opponent to make their move...");
            announcedOpponentMoveWait = true;
          }
          await sleep(PLAY_POLL_INTERVAL_MS);
          continue;
        }

        shouldReleaseOnExit = false;
        console.log("Both agents joined. It is your turn.");
        console.log("");
        console.log(renderGameBoard(game));
        const lastMove = game.history[game.history.length - 1];
        if (lastMove) {
          console.log("");
          console.log(`Last move: ${lastMove.san} by ${lastMove.by}`);
        }
        console.log("");
        console.log(`Play with: agent-chess play ${joined.ticket} <move> --thinking "<reasoning>"`);
        return;
      }
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  });

program
  .command("request-draw")
  .description("Request a draw from the other agent.")
  .argument("<ticketId>", "Ticket ID returned by join")
  .helpOption(false)
  .action(async (ticketId: string) => {
    const ticket = await resolveTicketForPlay(ticketId);
    const game = await requestDraw(store, ticket.gameId, ticket.ticketId);
    output(`Draw request sent for game ${game.id}.`, false);
  });

program
  .command("accept-draw")
  .description("Accept the current draw request and end the game as a draw.")
  .argument("<ticketId>", "Ticket ID returned by join")
  .helpOption(false)
  .action(async (ticketId: string) => {
    const ticket = await resolveTicketForPlay(ticketId);
    const game = await acceptDraw(store, ticket.gameId, ticket.ticketId);
    output(
      [
        renderGameBoard(game),
        "",
        gameSummary(game),
      ].join("\n"),
      false,
    );
  });

program
  .command("play")
  .description(
    "Submit one move and block until an opponent move is detected, the game ends, or 2 minutes pass.",
  )
  .argument("<ticketId>", "Ticket ID returned by join")
  .argument("<move>", "Move in SAN or UCI")
  .option("--thinking <text>", "Reasoning notes for this move (expected for every play)")
  .helpOption(false)
  .addHelpText(
    "after",
    `
Usage:
  agent-chess play <ticketId> <move>

Notes:
  - This command always waits for opponent progress after your move.
  - If it is not your turn yet, this command waits for your turn before submitting.
  - If the opponent requested a draw, the first play call prints a prompt and exits.
  - After that prompt, run play again to continue as an implicit decline.
  - At the end of each turn, this command writes a step-by-step replay HTML file.
  - Always include --thinking so your move rationale appears in the live UI.
  - Do not open a second session to play the opposite color; wait for another agent to move.
  - Join first to get your ticket id.
  - Timeout is fixed at 2 minutes.
  - Exit code is 2 on timeout.
`,
  )
  .action(
    async (
      ticketId: string,
      moveInput: string,
      options: { thinking?: string },
    ) => {
      const ticket = await resolveTicketForPlay(ticketId);
      const drawGate = await gatePlayForPendingDraw(store, ticket.gameId, ticket.ticketId);
      if (drawGate.state === "prompt" && drawGate.request) {
        output(renderDrawRequestPlayPrompt(ticket.ticketId, drawGate.request.requestedAt), false);
        return;
      }

      if (!options.thinking?.trim()) {
        throw new CliError("Missing required --thinking text.");
      }

      const preMoveWait = await waitForTurnToSubmit(ticket);
      if (preMoveWait.state !== "ready") {
        if (preMoveWait.state === "timeout") {
          process.exitCode = 2;
        }
        const renderedBoard = renderGameBoard(preMoveWait.game);
        output(
          renderPlayResult(
            preMoveWait.game,
            renderedBoard,
            preMoveWait.state === "timeout" ? "timeout" : "game-finished",
            preMoveWait.waitedMs,
            preMoveWait.polls,
            ticket.side,
          ),
          false,
        );
        return;
      }

      const result = await makeMove(store, ticket.gameId, ticket.ticketId, moveInput, {
        thinking: options.thinking,
      });

      const wait = await waitForOpponentMove(ticket.gameId, ticket.ticketId, result.game.history.length);
      if (wait.state === "timeout") {
        process.exitCode = 2;
      }
      const renderedBoard = renderGameBoard(wait.game);

      output(
        renderPlayResult(
          wait.game,
          renderedBoard,
          wait.state,
          wait.waitedMs,
          wait.polls,
          ticket.side,
        ),
        false,
      );
    },
  );

program
  .command("board")
  .description("Render the current board view in terminal-friendly Unicode/TUI format.")
  .action(async () => {
    const game = await requireSingleActiveGame();
    const renderedBoard = renderGameBoard(game);
    const lines = [
      renderedBoard,
      "",
      "Live view terminal command: agent-chess ui",
      "",
      gameSummary(game),
    ];
    if (game.history.length > 0) {
      const last = game.history[game.history.length - 1];
      lines.push("", `Last move: ${last.san} by ${last.by}`);
    }
    output(lines.join("\n"), false);
  });

program
  .command("help")
  .description("display help for command")
  .argument("[command]", "command name")
  .helpOption(false)
  .action(async (commandName?: string) => {
    if (commandName) {
      const target = program.commands.find((command) => command.name() === commandName);
      if (!target) {
        throw new CliError(`Unknown command '${commandName}'.`);
      }
      target.outputHelp();
      return;
    }

    program.outputHelp();
    console.log("");
    const games = await loadActiveGames();
    console.log(renderActiveGamesForHelp(games));
  });

async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs;

  const knownCommands = new Set([
    "play",
    "join",
    "request-draw",
    "accept-draw",
    "board",
    "ui",
    "reset",
    "help",
  ]);
  const firstToken = args[0];
  const showTopLevelHelpWithGames =
    args.length === 0 ||
    ((args.includes("--help") || args.includes("-h")) && (!firstToken || !knownCommands.has(firstToken)));

  if (showTopLevelHelpWithGames) {
    program.outputHelp();
    console.log("");
    const games = await loadActiveGames();
    console.log(renderActiveGamesForHelp(games));
    return;
  }

  await program.parseAsync([process.argv[0] ?? "node", process.argv[1] ?? "agent-chess", ...args]);
}

runCli().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error) {
    console.error(`Unexpected error: ${error.message}`);
  } else {
    console.error("Unexpected error");
  }
  process.exitCode = 1;
});
