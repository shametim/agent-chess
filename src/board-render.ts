import { Chess } from "chess.js";
import type { GameRecord } from "./types.js";

const WHITE_PIECES: Record<string, string> = {
  p: "♙",
  n: "♘",
  b: "♗",
  r: "♖",
  q: "♕",
  k: "♔",
};

const BLACK_PIECES: Record<string, string> = {
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
};

export function renderBoardFromFen(fen: string): string {
  const chess = new Chess(fen);
  const grid = chess.board();
  const lines: string[] = [];

  for (let rankIndex = 0; rankIndex < 8; rankIndex += 1) {
    const row = grid[rankIndex]!;
    const cells = row
      .map((piece) => {
        if (!piece) {
          return "·";
        }
        return piece.color === "w" ? WHITE_PIECES[piece.type] : BLACK_PIECES[piece.type];
      })
      .join(" ");
    lines.push(cells);
  }

  return lines.join("\n");
}

export function renderGameBoard(game: GameRecord): string {
  const fen = game.positions[game.positions.length - 1];
  return renderBoardFromFen(fen);
}
