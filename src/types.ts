export type Side = "white" | "black";
export type Turn = "w" | "b";

export type GameStatus =
  | "active"
  | "forfeit-illegal-moves"
  | "checkmate"
  | "stalemate"
  | "draw-insufficient-material"
  | "draw-threefold-repetition"
  | "draw-fifty-move-rule"
  | "draw-inactivity-timeout"
  | "draw";

export interface MoveRecord {
  ply: number;
  side: Side;
  by: string;
  san: string;
  lan: string;
  from: string;
  to: string;
  promotion?: string;
  thinking?: string;
  fenBefore: string;
  fenAfter: string;
  turnStartedAt: string;
  turnDurationMs: number;
  createdAt: string;
}

export interface IllegalMoveRecord {
  attemptedBy: string;
  moveInput: string;
  reason: string;
  expectedTurn: Side | null;
  expectedAgent: string | null;
  statusAtAttempt: GameStatus;
  createdAt: string;
}

export interface DrawRequestRecord {
  requestedBySide: Side;
  requestedByTicketId: string;
  requestedAt: string;
  promptShownToTicketId: string | null;
  promptShownAt: string | null;
}

export interface GameRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  players: {
    white: string | null;
    black: string | null;
  };
  playerModels: {
    white: string | null;
    black: string | null;
  };
  turn: Turn;
  status: GameStatus;
  winner: Side | null;
  resultText: string | null;
  turnStartedAt: string;
  history: MoveRecord[];
  illegalMoves: IllegalMoveRecord[];
  positions: string[];
  drawRequest: DrawRequestRecord | null;
}

export interface CreateGameOptions {
  white?: string;
  black?: string;
}

export interface JoinResult {
  game: GameRecord;
  side: Side;
  ticket: string;
}

export interface TicketRecord {
  ticketId: string;
  gameId: string;
  agentId: string;
  modelId: string;
  side: Side;
  createdAt: string;
  updatedAt: string;
}

export interface MoveResult {
  game: GameRecord;
  move: MoveRecord;
}
