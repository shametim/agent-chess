import { Chess } from "chess.js";
import type { Move } from "chess.js";
import { randomInt } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  CreateGameOptions,
  DrawRequestRecord,
  GameRecord,
  JoinResult,
  MoveRecord,
  MoveResult,
  Side,
  TicketRecord,
  Turn,
} from "./types.js";
import {
  CliError,
  deleteTicket,
  hasTicket,
  listGames,
  loadGame,
  loadTicket,
  saveGame,
  saveTicket,
  type Store,
} from "./storage.js";

const START_FEN = "rn1qkbnr/pppb1ppp/3p4/4p3/4P3/3P1N2/PPPQ1PPP/RNB1KB1R w KQkq - 0 1";
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_ILLEGAL_MOVES = 5;

// Use the actual canonical initial board FEN from chess.js to avoid parser mismatch with manual literals.
const CANONICAL_START_FEN = new Chess().fen();
const SIMPLE_GAME_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;
const JOIN_LOCK_TIMEOUT_MS = 5000;
const JOIN_LOCK_POLL_MS = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJoinTicket(length = 5): string {
  let ticket = "";
  for (let i = 0; i < length; i += 1) {
    ticket += String.fromCharCode(65 + randomInt(26));
  }
  return ticket;
}

async function createUniqueJoinTicket(store: Store): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = createJoinTicket();
    if (!(await hasTicket(store, candidate))) {
      return candidate;
    }
  }
  throw new CliError("Unable to allocate a join ticket. Please retry.");
}

function joinLockPath(store: Store, gameId: string): string {
  return path.join(store.dataDir, "locks", `join-${gameId}.lock`);
}

async function withJoinLock<T>(store: Store, gameId: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(store.dataDir, "locks");
  await mkdir(lockDir, { recursive: true });
  const lockPath = joinLockPath(store, gameId);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch {
      if (Date.now() - startedAt >= JOIN_LOCK_TIMEOUT_MS) {
        throw new CliError(`Timed out waiting to join game ${gameId}. Please retry.`);
      }
      await sleep(JOIN_LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function sortByOldestUpdateFirst(a: GameRecord, b: GameRecord): number {
  const aMs = parseIsoMs(a.updatedAt) ?? 0;
  const bMs = parseIsoMs(b.updatedAt) ?? 0;
  return aMs - bMs;
}

async function allocateGameId(store: Store): Promise<string> {
  const games = await listGames(store);
  const refreshedGames = await Promise.all(games.map((game) => applyInactivityTimeout(store, game)));
  const active = refreshedGames.filter((game) => game.status === "active");
  if (active.length > 0) {
    throw new CliError(`Game ${active[0].id} is busy. Finish it before creating a new game.`);
  }

  const usedSimpleIds = new Set(
    refreshedGames
      .map((game) => game.id)
      .filter((id): id is (typeof SIMPLE_GAME_IDS)[number] => SIMPLE_GAME_IDS.includes(id as (typeof SIMPLE_GAME_IDS)[number])),
  );
  const firstFree = SIMPLE_GAME_IDS.find((id) => !usedSimpleIds.has(id));
  if (firstFree) {
    return firstFree;
  }

  const recyclable = refreshedGames
    .filter((game) => SIMPLE_GAME_IDS.includes(game.id as (typeof SIMPLE_GAME_IDS)[number]))
    .sort(sortByOldestUpdateFirst);
  if (recyclable.length > 0) {
    return recyclable[0].id;
  }
  return SIMPLE_GAME_IDS[0];
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function elapsedMs(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function normalizeAnnotation(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 1200);
}

function sideFromTurn(turn: Turn): Side {
  return turn === "w" ? "white" : "black";
}

function turnFromSide(side: Side): Turn {
  return side === "white" ? "w" : "b";
}

function normalizeMoveInput(moveInput: string): string | { from: string; to: string; promotion?: string } {
  const trimmed = moveInput.trim();
  const uci = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/;
  const match = trimmed.match(uci);
  if (!match) {
    return trimmed;
  }
  return {
    from: match[1],
    to: match[2],
    promotion: match[3]?.toLowerCase(),
  };
}

function evaluateResult(chess: Chess): { status: GameRecord["status"]; winner: Side | null; resultText: string | null } {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "black" : "white";
    return {
      status: "checkmate",
      winner,
      resultText: `Checkmate. ${winner} wins.`,
    };
  }
  if (chess.isStalemate()) {
    return {
      status: "stalemate",
      winner: null,
      resultText: "Draw by stalemate.",
    };
  }
  if (chess.isInsufficientMaterial()) {
    return {
      status: "draw-insufficient-material",
      winner: null,
      resultText: "Draw by insufficient material.",
    };
  }
  if (chess.isThreefoldRepetition()) {
    return {
      status: "draw-threefold-repetition",
      winner: null,
      resultText: "Draw by threefold repetition.",
    };
  }
  if (chess.isDrawByFiftyMoves()) {
    return {
      status: "draw-fifty-move-rule",
      winner: null,
      resultText: "Draw by fifty-move rule.",
    };
  }
  if (chess.isDraw()) {
    return {
      status: "draw",
      winner: null,
      resultText: "Draw.",
    };
  }

  return {
    status: "active",
    winner: null,
    resultText: null,
  };
}

function ensureAgentName(agentId: string): void {
  if (!agentId.trim()) {
    throw new CliError("Agent id cannot be empty.");
  }
}

function ensureTicketId(ticketId: string): void {
  if (!ticketId.trim()) {
    throw new CliError("Ticket id cannot be empty.");
  }
}

function normalizeTicketId(ticketId: string): string {
  return ticketId.trim().toUpperCase();
}

function sideForTicket(game: GameRecord, ticketId: string): Side | null {
  if (game.players.white === ticketId) {
    return "white";
  }
  if (game.players.black === ticketId) {
    return "black";
  }
  return null;
}

function oppositeSide(side: Side): Side {
  return side === "white" ? "black" : "white";
}

async function applyInactivityTimeout(store: Store, game: GameRecord): Promise<GameRecord> {
  if (game.status !== "active") {
    return game;
  }

  const lastMoveAt = game.history.at(-1)?.createdAt ?? game.createdAt;
  const lastMoveAtMs = parseIsoMs(lastMoveAt);
  if (lastMoveAtMs === null) {
    return game;
  }

  if (Date.now() - lastMoveAtMs < INACTIVITY_TIMEOUT_MS) {
    return game;
  }

  const endedAt = nowIso();
  game.status = "draw-inactivity-timeout";
  game.winner = null;
  game.resultText = "Draw by inactivity timeout (no moves for 5 minutes).";
  game.turnStartedAt = endedAt;
  game.drawRequest = null;
  game.updatedAt = endedAt;
  await saveGame(store, game);
  return game;
}

export async function createGame(store: Store, options: CreateGameOptions = {}): Promise<GameRecord> {
  if (options.white) {
    ensureAgentName(options.white);
  }
  if (options.black) {
    ensureAgentName(options.black);
  }
  const id = await allocateGameId(store);
  const time = nowIso();
  const game: GameRecord = {
    id,
    createdAt: time,
    updatedAt: time,
    players: {
      white: options.white?.trim() ?? null,
      black: options.black?.trim() ?? null,
    },
    playerModels: {
      white: options.white?.trim() ?? null,
      black: options.black?.trim() ?? null,
    },
    turn: "w",
    status: "active",
    winner: null,
    resultText: null,
    turnStartedAt: time,
    history: [],
    illegalMoves: [],
    positions: [CANONICAL_START_FEN],
    drawRequest: null,
  };
  await saveGame(store, game);
  return game;
}

export async function joinGame(
  store: Store,
  gameId: string,
  agentId: string,
  preferredSide?: Side,
): Promise<JoinResult> {
  return withJoinLock(store, gameId, async () => {
    ensureAgentName(agentId);
    const cleanAgent = agentId.trim();
    const game = await applyInactivityTimeout(store, await loadGame(store, gameId));

    if (game.status !== "active") {
      throw new CliError(`Game ${gameId} is already finished (${game.status}).`);
    }

    let assignedSide: Side | null = null;

    const assign = (side: Side): Side => {
      const target = turnFromSide(side) === "w" ? "white" : "black";
      if (game.players[target]) {
        throw new CliError(`${side} is already occupied by ticket ${game.players[target]}.`);
      }
      game.updatedAt = nowIso();
      return side;
    };

    if (!assignedSide) {
      if (preferredSide) {
        assignedSide = assign(preferredSide);
      } else if (!game.players.white && !game.players.black) {
        assignedSide = assign(randomInt(2) === 0 ? "white" : "black");
      } else if (!game.players.white) {
        assignedSide = assign("white");
      } else if (!game.players.black) {
        assignedSide = assign("black");
      } else {
        throw new CliError("Both seats are already occupied.");
      }
    }

    const ticketId = await createUniqueJoinTicket(store);
    game.players[assignedSide] = ticketId;
    game.playerModels[assignedSide] = cleanAgent;
    await saveGame(store, game);
    const now = nowIso();
    const ticket: TicketRecord = {
      ticketId,
      gameId: game.id,
      agentId: cleanAgent,
      modelId: cleanAgent,
      side: assignedSide,
      createdAt: now,
      updatedAt: now,
    };
    await saveTicket(store, ticket);

    return { game, side: assignedSide, ticket: ticketId };
  });
}

export async function abandonJoinTicketIfUnpaired(store: Store, ticketId: string): Promise<boolean> {
  ensureTicketId(ticketId);
  let ticket: TicketRecord;
  try {
    ticket = await loadTicket(store, ticketId);
  } catch {
    return false;
  }

  return withJoinLock(store, ticket.gameId, async () => {
    const game = await applyInactivityTimeout(store, await loadGame(store, ticket.gameId));
    const seatTicket = game.players[ticket.side];
    if (seatTicket !== ticket.ticketId) {
      await deleteTicket(store, ticket.ticketId);
      return false;
    }

    const opponentSide: Side = ticket.side === "white" ? "black" : "white";
    const opponentJoined = Boolean(game.players[opponentSide]);
    if (opponentJoined) {
      return false;
    }

    game.players[ticket.side] = null;
    game.playerModels[ticket.side] = null;
    game.updatedAt = nowIso();
    await saveGame(store, game);
    await deleteTicket(store, ticket.ticketId);
    return true;
  });
}

export async function getGame(store: Store, gameId: string): Promise<GameRecord> {
  return applyInactivityTimeout(store, await loadGame(store, gameId));
}

export async function isAgentsTurn(store: Store, gameId: string, ticketId: string): Promise<boolean> {
  ensureTicketId(ticketId);
  const game = await applyInactivityTimeout(store, await loadGame(store, gameId));
  const expected = sideFromTurn(game.turn);
  const currentAgent = game.players[expected];
  return currentAgent === normalizeTicketId(ticketId);
}

export async function requestDraw(store: Store, gameId: string, ticketId: string): Promise<GameRecord> {
  ensureTicketId(ticketId);
  const cleanTicket = normalizeTicketId(ticketId);
  const game = await applyInactivityTimeout(store, await loadGame(store, gameId));

  if (game.status !== "active") {
    throw new CliError(`Game ${gameId} is already finished (${game.status}).`);
  }

  const requesterSide = sideForTicket(game, cleanTicket);
  if (!requesterSide) {
    throw new CliError(`Ticket ${cleanTicket} is not seated in game ${gameId}.`);
  }

  const opponentSide = oppositeSide(requesterSide);
  if (!game.players[opponentSide]) {
    throw new CliError("Cannot request a draw until both agents have joined.");
  }

  const existingRequest = game.drawRequest;
  if (existingRequest) {
    if (existingRequest.requestedByTicketId === cleanTicket) {
      throw new CliError("You already requested a draw. Wait for the opponent response.");
    }
    throw new CliError("Opponent already requested a draw. Use accept-draw or play to continue.");
  }

  const requestedAt = nowIso();
  game.drawRequest = {
    requestedBySide: requesterSide,
    requestedByTicketId: cleanTicket,
    requestedAt,
    promptShownToTicketId: null,
    promptShownAt: null,
  };
  game.updatedAt = requestedAt;
  await saveGame(store, game);
  return game;
}

export async function acceptDraw(store: Store, gameId: string, ticketId: string): Promise<GameRecord> {
  ensureTicketId(ticketId);
  const cleanTicket = normalizeTicketId(ticketId);
  const game = await applyInactivityTimeout(store, await loadGame(store, gameId));

  if (game.status !== "active") {
    throw new CliError(`Game ${gameId} is already finished (${game.status}).`);
  }

  const accepterSide = sideForTicket(game, cleanTicket);
  if (!accepterSide) {
    throw new CliError(`Ticket ${cleanTicket} is not seated in game ${gameId}.`);
  }

  const pending = game.drawRequest;
  if (!pending) {
    throw new CliError("No pending draw request.");
  }

  if (pending.requestedByTicketId === cleanTicket) {
    throw new CliError("You requested this draw. Wait for your opponent to accept.");
  }

  const acceptedAt = nowIso();
  game.status = "draw";
  game.winner = null;
  game.resultText = "Draw by agreement.";
  game.turnStartedAt = acceptedAt;
  game.drawRequest = null;
  game.updatedAt = acceptedAt;
  await saveGame(store, game);
  return game;
}

export interface DrawRequestGateResult {
  state: "none" | "prompt";
  game: GameRecord;
  request: DrawRequestRecord | null;
}

export async function gatePlayForPendingDraw(store: Store, gameId: string, ticketId: string): Promise<DrawRequestGateResult> {
  ensureTicketId(ticketId);
  const cleanTicket = normalizeTicketId(ticketId);
  const game = await applyInactivityTimeout(store, await loadGame(store, gameId));

  if (game.status !== "active" || !game.drawRequest) {
    return {
      state: "none",
      game,
      request: null,
    };
  }

  const request = game.drawRequest;
  if (request.requestedByTicketId === cleanTicket) {
    return {
      state: "none",
      game,
      request,
    };
  }

  const updatedAt = nowIso();
  if (request.promptShownToTicketId === cleanTicket) {
    game.drawRequest = null;
    game.updatedAt = updatedAt;
    await saveGame(store, game);
    return {
      state: "none",
      game,
      request,
    };
  }

  game.drawRequest = {
    ...request,
    promptShownToTicketId: cleanTicket,
    promptShownAt: updatedAt,
  };
  game.updatedAt = updatedAt;
  await saveGame(store, game);
  return {
    state: "prompt",
    game,
    request: game.drawRequest,
  };
}

export async function makeMove(
  store: Store,
  gameId: string,
  ticketId: string,
  moveInput: string,
  annotations: { thinking?: string } = {},
): Promise<MoveResult> {
  ensureTicketId(ticketId);
  const cleanTicket = normalizeTicketId(ticketId);
  const game = await applyInactivityTimeout(store, await loadGame(store, gameId));
  game.illegalMoves ??= [];
  game.turnStartedAt = game.turnStartedAt || game.updatedAt || game.createdAt;

  const recordIllegalMove = async (reason: string): Promise<never> => {
    const expectedTurn = game.status === "active" ? sideFromTurn(game.turn) : null;
    const expectedAgent = expectedTurn ? game.players[expectedTurn] : null;
    const attemptedAt = nowIso();
    game.illegalMoves.push({
      attemptedBy: cleanTicket,
      moveInput,
      reason,
      expectedTurn,
      expectedAgent,
      statusAtAttempt: game.status,
      createdAt: attemptedAt,
    });
    let failureReason = reason;

    let illegalStreak = 0;
    for (let idx = game.illegalMoves.length - 1; idx >= 0; idx -= 1) {
      if (game.illegalMoves[idx]?.attemptedBy !== cleanTicket) {
        break;
      }
      illegalStreak += 1;
    }

    if (game.status === "active" && illegalStreak >= MAX_CONSECUTIVE_ILLEGAL_MOVES) {
      const offenderSide: Side | null =
        game.players.white === cleanTicket ? "white" : game.players.black === cleanTicket ? "black" : null;
      const winner: Side | null =
        offenderSide === "white" ? "black" : offenderSide === "black" ? "white" : null;

      game.status = "forfeit-illegal-moves";
      game.winner = winner;
      game.resultText = null;
      game.turnStartedAt = attemptedAt;
      failureReason = reason;
    }

    game.updatedAt = attemptedAt;
    await saveGame(store, game);
    throw new CliError(failureReason);
  };

  if (game.status !== "active") {
    return recordIllegalMove(`Game ${gameId} is already finished (${game.status}).`);
  }

  const currentSide = sideFromTurn(game.turn);
  const currentAgent = game.players[currentSide];
  if (!currentAgent) {
    return recordIllegalMove(`No agent has joined as ${currentSide} yet.`);
  }
  if (currentAgent !== cleanTicket) {
    return recordIllegalMove(`It is ${currentSide}'s turn and controlled by ticket ${currentAgent}.`);
  }

  const fenBefore = game.positions[game.positions.length - 1] ?? CANONICAL_START_FEN;
  const chess = new Chess(fenBefore);

  let moved: Move;
  const normalized = normalizeMoveInput(moveInput);
  try {
    moved = chess.move(normalized as Parameters<Chess["move"]>[0]);
  } catch (error) {
    return recordIllegalMove(`Illegal move '${moveInput}'.`);
  }
  if (!moved) {
    return recordIllegalMove(`Illegal move '${moveInput}'.`);
  }

  const movedAt = nowIso();
  const turnStartedAt = game.turnStartedAt || game.updatedAt || game.createdAt;
  const thinking = normalizeAnnotation(annotations.thinking);
  const fenAfter = chess.fen();
  const moveRecord: MoveRecord = {
    ply: game.history.length + 1,
    side: currentSide,
    by: cleanTicket,
    san: moved.san,
    lan: moved.lan,
    from: moved.from,
    to: moved.to,
    promotion: moved.promotion,
    thinking,
    fenBefore,
    fenAfter,
    turnStartedAt,
    turnDurationMs: elapsedMs(turnStartedAt, movedAt),
    createdAt: movedAt,
  };

  game.history.push(moveRecord);
  game.positions.push(fenAfter);
  game.turn = chess.turn() as Turn;
  const result = evaluateResult(chess);
  game.status = result.status;
  game.winner = result.winner;
  game.resultText = result.resultText;
  game.turnStartedAt = movedAt;
  game.drawRequest = null;
  game.updatedAt = movedAt;

  await saveGame(store, game);
  return {
    game,
    move: moveRecord,
  };
}

export function sideToTurn(side: Side): Turn {
  return turnFromSide(side);
}

export function turnToSide(turn: Turn): Side {
  return sideFromTurn(turn);
}

export const INTERNALS = {
  START_FEN,
  CANONICAL_START_FEN,
};
