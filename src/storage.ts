import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { DrawRequestRecord, GameRecord, Side, TicketRecord } from "./types.js";

const DEFAULT_DATA_DIR = path.join(homedir(), ".agent-chess-data");

export interface Store {
  dataDir: string;
  gamesDir: string;
  ticketsDir: string;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function createStore(dataDir = DEFAULT_DATA_DIR): Store {
  return {
    dataDir,
    gamesDir: path.join(dataDir, "games"),
    ticketsDir: path.join(dataDir, "tickets"),
  };
}

export async function ensureStore(store: Store): Promise<void> {
  await Promise.all([
    mkdir(store.gamesDir, { recursive: true }),
    mkdir(store.ticketsDir, { recursive: true }),
  ]);
}

function gamePath(store: Store, gameId: string): string {
  return path.join(store.gamesDir, `${gameId}.json`);
}

function ticketPath(store: Store, ticketId: string): string {
  return path.join(store.ticketsDir, `${ticketId}.json`);
}

function parseIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

function parseNonNegativeMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return Math.max(0, fallback);
}

function parseSide(value: unknown): "white" | "black" | null {
  if (value === "white" || value === "black") {
    return value;
  }
  return null;
}

function normalizeTicketRecord(ticket: TicketRecord): TicketRecord {
  const now = new Date().toISOString();
  const normalizedSide = parseSide(ticket.side) as Side | null;
  if (!normalizedSide) {
    throw new CliError(`Ticket ${ticket.ticketId} is invalid (missing side).`);
  }

  const ticketId = typeof ticket.ticketId === "string" ? ticket.ticketId.trim().toUpperCase() : "";
  const gameId = typeof ticket.gameId === "string" ? ticket.gameId.trim() : "";
  const agentId = typeof ticket.agentId === "string" ? ticket.agentId.trim() : "";
  const modelId = typeof ticket.modelId === "string" ? ticket.modelId.trim() : "";
  if (!ticketId || !gameId || !agentId || !modelId) {
    throw new CliError(`Ticket ${ticket.ticketId} is invalid.`);
  }

  return {
    ticketId,
    gameId,
    agentId,
    modelId,
    side: normalizedSide,
    createdAt: parseIso(ticket.createdAt, now),
    updatedAt: parseIso(ticket.updatedAt, now),
  };
}

function parseOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalTicketId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGameRecord(game: GameRecord): GameRecord {
  const createdAt = parseIso(game.createdAt, new Date().toISOString());
  const updatedAt = parseIso(game.updatedAt, createdAt);
  const turnStartedAt = parseIso(
    (game as Partial<GameRecord>).turnStartedAt,
    game.history.at(-1)?.createdAt ?? updatedAt,
  );

  const history = (Array.isArray(game.history) ? game.history : []).map((move) => {
    const created = parseIso(move.createdAt, updatedAt);
    const started = parseIso((move as Partial<(typeof game.history)[number]>).turnStartedAt, created);
    const fallbackElapsed = Math.max(0, Date.parse(created) - Date.parse(started));
    const thinking = parseOptionalText((move as Partial<(typeof game.history)[number]>).thinking);
    return {
      ply: move.ply,
      side: move.side,
      by: move.by,
      san: move.san,
      lan: move.lan,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      thinking,
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      createdAt: created,
      turnStartedAt: started,
      turnDurationMs: parseNonNegativeMs(
        (move as Partial<(typeof game.history)[number]>).turnDurationMs,
        fallbackElapsed,
      ),
    };
  });

  const illegalMoves = (
    Array.isArray((game as Partial<GameRecord>).illegalMoves)
      ? ((game as Partial<GameRecord>).illegalMoves ?? [])
      : []
  ).map((attempt) => {
    const expectedTurn = parseSide(attempt.expectedTurn);
    return {
      attemptedBy: typeof attempt.attemptedBy === "string" ? attempt.attemptedBy : "unknown-agent",
      moveInput: typeof attempt.moveInput === "string" ? attempt.moveInput : "",
      reason: typeof attempt.reason === "string" ? attempt.reason : "Illegal move attempt.",
      expectedTurn,
      expectedAgent: typeof attempt.expectedAgent === "string" ? attempt.expectedAgent : null,
      statusAtAttempt:
        typeof attempt.statusAtAttempt === "string" ? attempt.statusAtAttempt : game.status,
      createdAt: parseIso(attempt.createdAt, updatedAt),
    };
  });

  let drawRequest: DrawRequestRecord | null = null;
  const rawDrawRequest = (game as Partial<GameRecord>).drawRequest;
  if (rawDrawRequest && typeof rawDrawRequest === "object") {
    const requestedBySide = parseSide((rawDrawRequest as Partial<DrawRequestRecord>).requestedBySide);
    const requestedByTicketId = parseOptionalTicketId(
      (rawDrawRequest as Partial<DrawRequestRecord>).requestedByTicketId,
    );
    if (requestedBySide && requestedByTicketId) {
      const promptShownToTicketId = parseOptionalTicketId(
        (rawDrawRequest as Partial<DrawRequestRecord>).promptShownToTicketId,
      );
      const promptShownAt = promptShownToTicketId
        ? parseIso((rawDrawRequest as Partial<DrawRequestRecord>).promptShownAt, updatedAt)
        : null;
      drawRequest = {
        requestedBySide,
        requestedByTicketId,
        requestedAt: parseIso((rawDrawRequest as Partial<DrawRequestRecord>).requestedAt, updatedAt),
        promptShownToTicketId,
        promptShownAt,
      };
    }
  }

  return {
    ...game,
    players: {
      white: typeof game.players?.white === "string" ? game.players.white : null,
      black: typeof game.players?.black === "string" ? game.players.black : null,
    },
    playerModels: {
      white:
        typeof (game as Partial<GameRecord>).playerModels?.white === "string"
          ? (game as Partial<GameRecord>).playerModels?.white ?? null
          : typeof game.players?.white === "string"
            ? game.players.white
            : null,
      black:
        typeof (game as Partial<GameRecord>).playerModels?.black === "string"
          ? (game as Partial<GameRecord>).playerModels?.black ?? null
          : typeof game.players?.black === "string"
            ? game.players.black
            : null,
    },
    createdAt,
    updatedAt,
    turnStartedAt,
    history,
    illegalMoves,
    drawRequest,
  };
}

export async function loadGame(store: Store, gameId: string): Promise<GameRecord> {
  await ensureStore(store);
  const target = gamePath(store, gameId);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    throw new CliError(`Game ${gameId} was not found.`);
  }
  try {
    return normalizeGameRecord(JSON.parse(raw) as GameRecord);
  } catch {
    throw new CliError(`Game file for ${gameId} is invalid JSON.`);
  }
}

export async function saveGame(store: Store, game: GameRecord): Promise<void> {
  await ensureStore(store);
  const target = gamePath(store, game.id);
  await writeFile(target, JSON.stringify(game, null, 2), "utf8");
}

export async function listGames(store: Store): Promise<GameRecord[]> {
  await ensureStore(store);
  const files = await readdir(store.gamesDir, { withFileTypes: true });
  const games: GameRecord[] = [];

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const gameId = entry.name.slice(0, -5);
    try {
      const game = await loadGame(store, gameId);
      games.push(game);
    } catch {
      // Ignore corrupt files during listing so one bad file does not block the CLI.
    }
  }

  games.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return games;
}

export async function saveTicket(store: Store, ticket: TicketRecord): Promise<void> {
  await ensureStore(store);
  const normalized = normalizeTicketRecord(ticket);
  const target = ticketPath(store, normalized.ticketId);
  await writeFile(target, JSON.stringify(normalized, null, 2), "utf8");
}

export async function loadTicket(store: Store, ticketId: string): Promise<TicketRecord> {
  await ensureStore(store);
  const normalizedId = ticketId.trim().toUpperCase();
  if (!normalizedId) {
    throw new CliError("Ticket id cannot be empty.");
  }

  const target = ticketPath(store, normalizedId);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    throw new CliError(`Ticket ${normalizedId} was not found.`);
  }

  try {
    return normalizeTicketRecord(JSON.parse(raw) as TicketRecord);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Ticket file for ${normalizedId} is invalid JSON.`);
  }
}

export async function hasTicket(store: Store, ticketId: string): Promise<boolean> {
  try {
    await loadTicket(store, ticketId);
    return true;
  } catch {
    return false;
  }
}

export async function deleteTicket(store: Store, ticketId: string): Promise<void> {
  await ensureStore(store);
  const normalizedId = ticketId.trim().toUpperCase();
  if (!normalizedId) {
    return;
  }
  const target = ticketPath(store, normalizedId);
  await unlink(target).catch(() => undefined);
}
