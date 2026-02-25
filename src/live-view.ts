import { createServer, type ServerResponse } from "node:http";
import { getGame } from "./chess-service.js";
import { CliError, listGames, type Store } from "./storage.js";
import type { GameRecord } from "./types.js";

interface LiveViewOptions {
  gameId?: string;
  host: string;
  port: number;
  pollMs: number;
  exitOnInactive?: boolean;
}

export interface LiveViewServer {
  url: string;
  close: () => Promise<void>;
}

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

function writeHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
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

async function loadGames(store: Store): Promise<GameRecord[]> {
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
  return allGames;
}

async function resolveLiveGame(store: Store, preferredGameId: string | undefined): Promise<GameRecord | null> {
  if (preferredGameId) {
    return getGame(store, preferredGameId);
  }
  const games = await loadGames(store);
  const activeGame = pickDefaultLiveGame(games.filter((game) => game.status === "active"));
  if (activeGame) {
    return activeGame;
  }
  return pickDefaultLiveGame(games);
}

function buildLiveHtml(gameId: string | undefined, pollMs: number): string {
  const payload = {
    gameId: gameId ?? null,
    pollMs,
  };
  const initialTitle = gameId ? `agent-chess Live View - ${gameId}` : "agent-chess Live View";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${initialTitle}</title>
  <style>
    :root {
      --bg: #1b1b1b;
      --panel: #242424;
      --surface: #2d2d2d;
      --ink: #ece9e5;
      --muted: #b1aba2;
      --accent: #67a657;
      --accent-soft: #2a3a28;
      --danger-soft: #3b2e31;
      --board-light: #b6c2a8;
      --board-dark: #6e7d63;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      padding: 18px;
    }

    .app {
      max-width: 1380px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
      position: relative;
    }

    .app-title {
      margin: 4px 0 2px;
      text-align: center;
      font-size: clamp(2rem, 5vw, 3.25rem);
      font-weight: 800;
      letter-spacing: 0.02em;
      color: var(--ink);
    }

    .app-usage {
      margin: 0 0 4px;
      min-height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: var(--muted);
      font-size: clamp(0.9rem, 2.2vw, 1.05rem);
    }

    .game-switch-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #2f3b26;
      border: 1px solid rgba(163, 207, 112, 0.4);
      color: #dfeec9;
      font-size: 0.95rem;
      line-height: 1.35;
    }

    .game-switch-banner.open {
      display: flex;
    }

    .game-switch-banner button {
      background: #6ea551;
      color: #112107;
      font-weight: 700;
      white-space: nowrap;
    }

    .repo-link {
      position: absolute;
      top: 2px;
      right: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      text-decoration: none;
      transition: background-color 140ms ease, transform 140ms ease, border-color 140ms ease;
    }

    .repo-link:hover {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.3);
      transform: translateY(-1px);
    }

    .repo-link svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }

    .card {
      border-radius: 14px;
      background: transparent;
      box-shadow: none;
      padding: 20px;
    }

    .sub {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .board-card {
      display: grid;
      gap: 12px;
    }

    .board-meta {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px 20px;
      flex-wrap: wrap;
    }

    #board-wrap {
      width: min(100%, 920px);
      margin: 0 auto;
      display: grid;
      gap: 6px;
    }

    .files-row {
      display: grid;
      grid-template-columns: minmax(86px, 120px) 24px minmax(0, 1fr) 24px minmax(86px, 120px);
      align-items: center;
      gap: 6px;
    }

    .board-row {
      display: grid;
      grid-template-columns: minmax(86px, 120px) 24px minmax(0, 1fr) 24px minmax(86px, 120px);
      align-items: stretch;
      gap: 6px;
    }

    #board {
      aspect-ratio: 1 / 1;
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      grid-template-rows: repeat(8, minmax(0, 1fr));
      border: 0;
      border-radius: 8px;
      overflow: hidden;
    }

    .sq {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: clamp(26px, 4.4vw, 60px);
      line-height: 1;
      user-select: none;
    }

    .light { background: var(--board-light); }
    .dark { background: var(--board-dark); }
    .sq.last-from::after,
    .sq.last-to::after {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: 6px;
      pointer-events: none;
    }
    .sq.last-from::after {
      border: 2px solid #fff0a8;
      background: rgba(255, 230, 110, 0.28);
      box-shadow: inset 0 0 0 1px rgba(46, 43, 30, 0.5);
    }
    .sq.last-to::after {
      border: 2px solid #ffd54a;
      background: rgba(255, 213, 74, 0.5);
      box-shadow: inset 0 0 0 1px rgba(46, 37, 6, 0.56);
    }

    .axis-files {
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: 0;
      padding: 0 2px;
    }

    .axis-ranks {
      display: grid;
      grid-template-rows: repeat(8, minmax(0, 1fr));
      gap: 0;
      height: 100%;
    }

    .axis-file,
    .axis-rank {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 600;
      line-height: 1;
      text-transform: lowercase;
      user-select: none;
    }

    .axis-rank {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .capture-slot {
      border-radius: 8px;
      background: transparent;
      padding: 6px 5px;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 6px;
    }

    .capture-left {
      background: transparent;
    }

    .capture-right {
      background: transparent;
    }

    .capture-title {
      font-size: 0.78rem;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: var(--muted);
      text-align: center;
      word-break: break-word;
    }

    .capture-pieces {
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      gap: 3px;
      font-size: clamp(18px, 2.1vw, 28px);
      line-height: 1;
      min-height: 36px;
    }

    .captured-piece {
      width: 0.95em;
      text-align: center;
      user-select: none;
    }

    .capture-empty {
      color: #9b958d;
      font-size: 0.95rem;
      line-height: 1;
      user-select: none;
    }

    .player-slot {
      border-radius: 10px;
      padding: 8px 12px;
      background: var(--surface);
      display: grid;
      gap: 5px;
      justify-items: center;
      text-align: center;
      position: relative;
      transition: background-color 140ms ease, box-shadow 140ms ease;
    }

    .player-black {
      background: var(--surface);
    }

    .player-white {
      background: var(--surface);
    }

    .player-slot.active-turn {
      box-shadow: inset 0 0 0 2px rgba(255, 212, 62, 0.9);
    }

    .player-slot.player-black.active-turn {
      background: #46503e;
    }

    .player-slot.player-white.active-turn {
      background: #46503e;
    }

    .player-slot.active-turn::before {
      content: "➜";
      position: absolute;
      left: -30px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 34px;
      font-weight: 900;
      color: #ffd54a;
      text-shadow: 0 0 12px rgba(255, 213, 74, 0.4);
      pointer-events: none;
    }

    .player-model {
      font-size: 1.06rem;
      line-height: 1.2;
      font-weight: 800;
      color: var(--ink);
      word-break: break-word;
    }

    .player-head {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .player-result {
      font-size: 0.72rem;
      line-height: 1;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 3px 8px;
    }

    .player-result.winner {
      background: #2d5a34;
      color: #d9f6de;
    }

    .player-result.loser {
      background: #603336;
      color: #ffd9d9;
    }

    .player-result.draw {
      background: #4a4a4a;
      color: #ece8e0;
    }

    .player-thinking {
      font-size: 1rem;
      color: #cdc7be;
      line-height: 1.4;
      word-break: break-word;
    }

    .player-slot.open-seat {
      background: #303030;
      box-shadow: inset 0 0 0 1px rgba(194, 188, 176, 0.2);
    }

    .replay-controls {
      display: none;
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.03);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    .replay-controls.open {
      display: grid;
      gap: 6px;
    }

    .replay-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
    }

    .replay-row label {
      font-size: 0.86rem;
      font-weight: 700;
      color: var(--muted);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .replay-row input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }

    .replay-status {
      font-size: 0.9rem;
      color: var(--muted);
      min-width: 94px;
      text-align: right;
    }

    button {
      font: inherit;
      border: 0;
      border-radius: 8px;
      background: var(--surface);
      color: var(--ink);
      padding: 7px 11px;
      cursor: pointer;
    }

    button.primary {
      background: var(--accent);
      color: white;
    }

    .panel-title {
      margin: 0 0 10px 0;
      font-size: 1rem;
    }

    .panel-title-inline {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .panel-help {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      color: var(--muted);
      font-size: 0.73rem;
      font-weight: 700;
      line-height: 1;
      cursor: help;
      user-select: none;
    }

    .panel-help::after {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      width: min(260px, 80vw);
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: #1f1f1f;
      color: var(--ink);
      font-size: 0.8rem;
      line-height: 1.35;
      text-align: left;
      white-space: normal;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 120ms ease;
      z-index: 20;
    }

    .panel-help:hover::after,
    .panel-help:focus-visible::after {
      opacity: 1;
      visibility: visible;
    }

    .list {
      max-height: 340px;
      overflow: auto;
      padding: 0;
      background: transparent;
    }

    .list-item {
      border-radius: 0;
      padding: 7px 0;
      margin-bottom: 0;
      background: transparent;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.93rem;
    }

    .list-item:last-child { border-bottom: 0; }

    .list-item.current {
      color: #f1ecd8;
      font-weight: 700;
      border-bottom-color: rgba(255, 213, 74, 0.45);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.91rem;
    }

    th, td {
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      text-align: left;
      padding: 6px 4px;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-weight: 600;
    }

    .empty {
      margin: 0;
      color: var(--muted);
      font-size: 0.92rem;
    }

    #recap {
      display: none;
    }

    #recap.open {
      display: grid;
      gap: 12px;
      animation: fadeIn 220ms ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 930px) {
      body { padding: 12px; }
      #board-wrap { width: 100%; max-width: 860px; }
    }

    @media (max-width: 640px) {
      .repo-link {
        top: 0;
        right: 0;
      }

      .board-meta {
        align-items: flex-start;
        gap: 8px;
      }

      .board-meta #outcome {
        width: 100%;
      }

      .replay-row {
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .replay-status {
        text-align: left;
        min-width: 0;
      }

      .player-slot.active-turn::before {
        left: -24px;
        font-size: 30px;
      }

      .files-row {
        grid-template-columns: 1fr;
      }

      .board-row {
        grid-template-columns: 1fr;
        gap: 8px;
      }

      .spacer,
      .axis-ranks {
        display: none;
      }

      .capture-slot {
        grid-template-rows: auto auto;
      }

      #board {
        order: 2;
      }

      .capture-left {
        order: 1;
      }

      .capture-right {
        order: 3;
      }
    }
  </style>
</head>
  <body>
  <main class="app">
    <a class="repo-link" href="https://github.com/shametim/agent-chess" target="_blank" rel="noreferrer" aria-label="Open agent-chess on GitHub" title="GitHub repository">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.38-2.53-.51-2.69-.98-.09-.24-.48-.98-.82-1.18-.28-.16-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.25 1.87.9 2.33.68.07-.53.28-.9.5-1.11-1.78-.21-3.64-.91-3.64-4.05 0-.9.31-1.64.82-2.21-.08-.21-.36-1.06.08-2.2 0 0 .67-.22 2.2.85a7.4 7.4 0 0 1 4 0c1.53-1.07 2.2-.85 2.2-.85.44 1.14.16 1.99.08 2.2.51.57.82 1.3.82 2.21 0 3.15-1.87 3.84-3.65 4.05.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.14.47.55.39A8.23 8.23 0 0 0 16 8.2C16 3.67 12.42 0 8 0z"/>
      </svg>
    </a>
    <h1 class="app-title">agent-chess CLI</h1>
    <p class="app-usage">Usage: simply instruct each agent to play a game of chess using agent-chess CLI</p>
    <section id="gameSwitchBanner" class="game-switch-banner" aria-hidden="true">
      <span id="gameSwitchMessage"></span>
      <button type="button" id="gameSwitchButton">Switch</button>
    </section>
    <section class="card board-card">
      <div class="board-meta">
        <p class="sub" id="outcome"></p>
      </div>

      <div id="board-wrap">
          <div class="files-row">
            <div class="spacer"></div>
            <div class="spacer"></div>
            <div class="player-slot player-black" id="blackSeat"></div>
            <div class="spacer"></div>
            <div class="spacer"></div>
          </div>
          <div class="files-row">
            <div class="spacer"></div>
            <div class="spacer"></div>
            <div class="axis-files" id="filesTop"></div>
            <div class="spacer"></div>
            <div class="spacer"></div>
          </div>
          <div class="board-row">
            <div class="capture-slot capture-left">
              <div class="capture-title" id="whiteCaptureTitle">-</div>
              <div class="capture-pieces" id="whiteCaptures"></div>
            </div>
            <div class="axis-ranks" id="ranksLeft"></div>
            <div id="board"></div>
            <div class="axis-ranks" id="ranksRight"></div>
            <div class="capture-slot capture-right">
              <div class="capture-title" id="blackCaptureTitle">-</div>
              <div class="capture-pieces" id="blackCaptures"></div>
            </div>
          </div>
          <div class="files-row">
            <div class="spacer"></div>
            <div class="spacer"></div>
            <div class="axis-files" id="filesBottom"></div>
            <div class="spacer"></div>
            <div class="spacer"></div>
          </div>
          <div class="files-row">
            <div class="spacer"></div>
            <div class="spacer"></div>
            <div class="player-slot player-white" id="whiteSeat"></div>
            <div class="spacer"></div>
            <div class="spacer"></div>
          </div>
      </div>

      <section id="replayControls" class="replay-controls" aria-hidden="true">
        <div class="replay-row">
          <label for="replayTimeline">Replay</label>
          <input id="replayTimeline" type="range" min="0" step="1" />
          <span id="replayStatus" class="replay-status"></span>
        </div>
      </section>

      <section>
        <h2 class="panel-title">Live Moves</h2>
        <div id="moves" class="list"></div>
      </section>
    </section>

    <section class="card" style="display:grid; gap:12px;">
      <section>
        <h2 class="panel-title panel-title-inline">
          Illegal Attempts
          <span
            class="panel-help"
            tabindex="0"
            data-tooltip="These are moves the AI agent attempted that were illegal."
            title="These are moves the AI agent attempted that were illegal."
            aria-label="These are moves the AI agent attempted that were illegal."
          >?</span>
        </h2>
        <div id="illegal" class="list"></div>
      </section>
    </section>

    <section id="recap" class="card">
      <h2 style="margin:0; font-size:1.05rem;">Game Recap</h2>

      <section>
        <h3 class="panel-title">Illegal Moves by Agent</h3>
        <table>
          <thead>
            <tr><th>Agent</th><th>Illegal moves</th></tr>
          </thead>
          <tbody id="illegalByModel"></tbody>
        </table>
      </section>

      <section>
        <h3 class="panel-title">Turn Timing by Agent</h3>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Turns</th>
              <th>Total</th>
              <th>Avg</th>
              <th>Slowest</th>
            </tr>
          </thead>
          <tbody id="timingByModel"></tbody>
        </table>
      </section>

      <section>
        <h3 class="panel-title">Per-Turn Timing</h3>
        <table>
          <thead>
            <tr>
              <th>Ply</th>
              <th>Agent</th>
              <th>Move</th>
              <th>Elapsed</th>
              <th>Thinking</th>
            </tr>
          </thead>
          <tbody id="timingByTurn"></tbody>
        </table>
      </section>
    </section>
  </main>

  <script>
    const config = ${escapeJsonForInlineScript(payload)};
    const PIECES = {
      wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
      bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
    };

    const boardEl = document.getElementById("board");
    const filesTopEl = document.getElementById("filesTop");
    const filesBottomEl = document.getElementById("filesBottom");
    const ranksLeftEl = document.getElementById("ranksLeft");
    const ranksRightEl = document.getElementById("ranksRight");
    const blackSeatEl = document.getElementById("blackSeat");
    const whiteSeatEl = document.getElementById("whiteSeat");
    const whiteCaptureTitleEl = document.getElementById("whiteCaptureTitle");
    const blackCaptureTitleEl = document.getElementById("blackCaptureTitle");
    const whiteCapturesEl = document.getElementById("whiteCaptures");
    const blackCapturesEl = document.getElementById("blackCaptures");
    const outcomeEl = document.getElementById("outcome");
    const replayControlsEl = document.getElementById("replayControls");
    const replayTimelineEl = document.getElementById("replayTimeline");
    const replayStatusEl = document.getElementById("replayStatus");
    const gameSwitchBannerEl = document.getElementById("gameSwitchBanner");
    const gameSwitchMessageEl = document.getElementById("gameSwitchMessage");
    const gameSwitchButtonEl = document.getElementById("gameSwitchButton");
    const movesEl = document.getElementById("moves");
    const illegalEl = document.getElementById("illegal");
    const recapEl = document.getElementById("recap");
    const illegalByModelEl = document.getElementById("illegalByModel");
    const timingByModelEl = document.getElementById("timingByModel");
    const timingByTurnEl = document.getElementById("timingByTurn");

    let pollTimer = null;
    let loading = false;
    let latestGame = null;
    let currentGameId = config.gameId;
    let suggestedGameId = null;
    let replayIndex = null;
    const friendlyGameIds = new Map();
    let nextFriendlyGameId = 1;

    function formatMs(ms) {
      const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      if (safe >= 60000) {
        return (safe / 60000).toFixed(2) + " min";
      }
      if (safe >= 1000) {
        return (safe / 1000).toFixed(2) + " sec";
      }
      return Math.round(safe) + " ms";
    }

    function friendlyGameNumber(gameId) {
      const key = String(gameId || "");
      if (!friendlyGameIds.has(key)) {
        friendlyGameIds.set(key, nextFriendlyGameId);
        nextFriendlyGameId += 1;
      }
      return friendlyGameIds.get(key);
    }

    function boardCellsFromFen(fen) {
      const boardPart = String(fen || "").split(" ")[0] || "";
      const rows = boardPart.split("/");
      const cells = [];
      for (const row of rows) {
        for (const ch of row) {
          if (/[1-8]/.test(ch)) {
            for (let i = 0; i < Number(ch); i += 1) cells.push(null);
          } else {
            cells.push(ch);
          }
        }
      }
      return cells;
    }

    function pieceAtSquare(cells, square) {
      if (!/^[a-h][1-8]$/.test(square)) {
        return null;
      }
      const fileIndex = square.charCodeAt(0) - "a".charCodeAt(0);
      const rank = Number(square[1]);
      const row = 8 - rank;
      const idx = row * 8 + fileIndex;
      const piece = cells[idx];
      return typeof piece === "string" ? piece : null;
    }

    function normalizePieceKind(value) {
      const kind = String(value || "").trim().toLowerCase();
      return /^[pnbrqk]$/.test(kind) ? kind : null;
    }

    function inferCapturedKind(move) {
      const from = typeof move?.from === "string" ? move.from.toLowerCase() : "";
      const to = typeof move?.to === "string" ? move.to.toLowerCase() : "";
      if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
        return null;
      }

      const cells = boardCellsFromFen(move?.fenBefore);
      const movingPiece = pieceAtSquare(cells, from);
      if (!movingPiece) {
        return null;
      }

      const targetPiece = pieceAtSquare(cells, to);
      if (targetPiece) {
        return targetPiece.toLowerCase();
      }

      if (movingPiece.toLowerCase() !== "p") {
        return null;
      }

      const fileDelta = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
      if (fileDelta !== 1) {
        return null;
      }

      const toRank = Number(to[1]);
      const capturedPawnRank = movingPiece === movingPiece.toUpperCase() ? toRank - 1 : toRank + 1;
      if (capturedPawnRank < 1 || capturedPawnRank > 8) {
        return null;
      }

      const enPassantSquare = to[0] + String(capturedPawnRank);
      const enPassantPawn = pieceAtSquare(cells, enPassantSquare);
      if (!enPassantPawn || enPassantPawn.toLowerCase() !== "p") {
        return null;
      }
      return "p";
    }

    function capturedKindFromMove(move) {
      const directKind = normalizePieceKind(move?.captured);
      if (directKind) {
        return directKind;
      }
      return inferCapturedKind(move);
    }

    function renderCapturedRack(container, pieceCodes) {
      if (!container) {
        return;
      }
      container.innerHTML = "";
      if (pieceCodes.length === 0) {
        const empty = document.createElement("span");
        empty.className = "capture-empty";
        empty.textContent = "—";
        container.appendChild(empty);
        return;
      }

      for (const pieceCode of pieceCodes) {
        const glyph = PIECES[pieceCode];
        if (!glyph) {
          continue;
        }
        const piece = document.createElement("span");
        piece.className = "captured-piece";
        piece.textContent = glyph;
        container.appendChild(piece);
      }
    }

    function renderCapturedPieces(game, upToPly) {
      const whiteCaptured = [];
      const blackCaptured = [];
      const history = Array.isArray(game.history) ? game.history : [];
      const moveLimit = Number.isFinite(upToPly) ? Math.max(0, Math.floor(upToPly)) : history.length;
      const visibleHistory = history.slice(0, Math.min(history.length, moveLimit));

      for (const move of visibleHistory) {
        const kind = capturedKindFromMove(move);
        if (!kind) {
          continue;
        }
        if (move.side === "white") {
          whiteCaptured.push("b" + kind);
        } else if (move.side === "black") {
          blackCaptured.push("w" + kind);
        }
      }

      renderCapturedRack(whiteCapturesEl, whiteCaptured);
      renderCapturedRack(blackCapturesEl, blackCaptured);
    }

    function renderBoardAxes() {
      const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];

      filesTopEl.innerHTML = "";
      filesBottomEl.innerHTML = "";
      ranksLeftEl.innerHTML = "";
      ranksRightEl.innerHTML = "";

      for (const file of files) {
        const top = document.createElement("div");
        top.className = "axis-file";
        top.textContent = file;
        filesTopEl.appendChild(top);

        const bottom = document.createElement("div");
        bottom.className = "axis-file";
        bottom.textContent = file;
        filesBottomEl.appendChild(bottom);
      }

      for (const rank of ranks) {
        const left = document.createElement("div");
        left.className = "axis-rank";
        left.textContent = rank;
        ranksLeftEl.appendChild(left);

        const right = document.createElement("div");
        right.className = "axis-rank";
        right.textContent = rank;
        ranksRightEl.appendChild(right);
      }
    }

    function renderBoard(fen, latestMove) {
      const cells = boardCellsFromFen(fen);
      const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const fromSquare = typeof latestMove?.from === "string" ? latestMove.from.toLowerCase() : null;
      const toSquare = typeof latestMove?.to === "string" ? latestMove.to.toLowerCase() : null;
      boardEl.innerHTML = "";
      for (let r = 0; r < 8; r += 1) {
        for (let c = 0; c < 8; c += 1) {
          const idx = r * 8 + c;
          const sq = document.createElement("div");
          sq.className = "sq " + ((r + c) % 2 === 0 ? "light" : "dark");
          const squareName = files[c] + String(8 - r);
          if (fromSquare && squareName === fromSquare) {
            sq.classList.add("last-from");
          }
          if (toSquare && squareName === toSquare) {
            sq.classList.add("last-to");
          }
          const pieceCode = cells[idx];
          if (pieceCode) {
            const side = pieceCode === pieceCode.toUpperCase() ? "w" : "b";
            const kind = pieceCode.toLowerCase();
            sq.textContent = PIECES[side + kind] ?? "";
          }
          boardEl.appendChild(sq);
        }
      }
    }

    function latestThinkingForSide(history, side) {
      if (!Array.isArray(history)) {
        return null;
      }
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const move = history[i];
        if (move?.side === side && typeof move?.thinking === "string" && move.thinking.trim()) {
          return move.thinking.trim();
        }
      }
      return null;
    }

    function gameResultLabel(game, side) {
      if (!game || game.status === "active") {
        return null;
      }
      const forfeit = game.status === "forfeit-illegal-moves";
      if (game.winner === side) {
        return { text: forfeit ? "Winner by Forfeit" : "Winner", className: "winner" };
      }
      if (game.winner === null) {
        return { text: "Draw", className: "draw" };
      }
      return { text: forfeit ? "Loser by Forfeit" : "Loser", className: "loser" };
    }

    function renderSeat(el, side, modelName, thinkingText, game) {
      if (!el) {
        return;
      }
      el.innerHTML = "";
      const cleanModelName = typeof modelName === "string" ? modelName.trim() : "";
      const hasModel = cleanModelName.length > 0;
      const head = document.createElement("div");
      head.className = "player-head";
      const model = document.createElement("div");
      model.className = "player-model";
      model.textContent = "Agent: " + (hasModel ? cleanModelName : "Open seat");
      head.appendChild(model);
      if (hasModel) {
        const result = gameResultLabel(game, side);
        if (result) {
          const badge = document.createElement("span");
          badge.className = "player-result " + result.className;
          badge.textContent = result.text;
          head.appendChild(badge);
        }
      }
      const move = document.createElement("div");
      move.className = "player-thinking";
      move.textContent = hasModel
        ? thinkingText || "—"
        : "Waiting for an agent to join.";
      el.classList.toggle("open-seat", !hasModel);
      el.appendChild(head);
      el.appendChild(move);
    }

    function renderCaptureTitle(container, modelName) {
      if (!container) {
        return;
      }
      const cleanModelName = typeof modelName === "string" ? modelName.trim() : "";
      container.textContent = cleanModelName || "Open seat (waiting for agent)";
    }

    function appendEmpty(container, text) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = text;
      container.appendChild(p);
    }

    function createCell(row, text) {
      const td = document.createElement("td");
      td.textContent = text;
      row.appendChild(td);
    }

    function summarizeByModel(items, keyField) {
      const map = new Map();
      for (const item of items) {
        const key = String(item[keyField] || "unknown-agent");
        map.set(key, (map.get(key) || 0) + 1);
      }
      return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }

    function summarizeTimingByModel(history) {
      const map = new Map();
      for (const move of history) {
        const model = String(move.by || "unknown-agent");
        const duration = Number(move.turnDurationMs || 0);
        const current = map.get(model) || {
          model,
          turns: 0,
          total: 0,
          slowest: 0,
        };
        current.turns += 1;
        current.total += duration;
        current.slowest = Math.max(current.slowest, duration);
        map.set(model, current);
      }
      return Array.from(map.values())
        .map((entry) => ({
          ...entry,
          average: entry.turns > 0 ? entry.total / entry.turns : 0,
        }))
        .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
    }

    function formatActor(ticketId, explicitSide) {
      const ticket = String(ticketId || "").trim();
      if (!ticket) {
        return "unknown-agent";
      }
      const side =
        explicitSide === "white" || explicitSide === "black"
          ? explicitSide
          : gameSideForTicket(ticket);
      if (!side) {
        return ticket;
      }
      const model = String((latestGame?.playerModels && latestGame.playerModels[side]) || "").trim();
      return model ? (model + " (" + ticket + ")") : ticket;
    }

    function gameSideForTicket(ticketId) {
      const clean = String(ticketId || "").trim();
      if (!clean || !latestGame?.players) {
        return null;
      }
      if (latestGame.players.white === clean) {
        return "white";
      }
      if (latestGame.players.black === clean) {
        return "black";
      }
      return null;
    }

    function renderMoves(game, currentPly) {
      movesEl.innerHTML = "";
      if (!Array.isArray(game.history) || game.history.length === 0) {
        appendEmpty(movesEl, "No moves yet.");
        return;
      }

      for (const move of game.history) {
        const div = document.createElement("div");
        div.className = "list-item";
        const notes = [];
        if (move.thinking) notes.push(move.thinking);
        const actor = formatActor(move.by, move.side);
        div.textContent =
          "#" +
          move.ply +
          " " +
          move.san +
          " by " +
          actor +
          " (" +
          formatMs(move.turnDurationMs || 0) +
          ")" +
          (notes.length > 0 ? " | " + notes.join(" | ") : "");
        if (move.ply === currentPly) {
          div.classList.add("current");
        }
        movesEl.appendChild(div);
      }
    }

    function renderIllegalAttempts(game) {
      illegalEl.innerHTML = "";
      if (!Array.isArray(game.illegalMoves) || game.illegalMoves.length === 0) {
        appendEmpty(illegalEl, "No illegal move attempts.");
        return;
      }

      for (const illegal of game.illegalMoves) {
        const div = document.createElement("div");
        div.className = "list-item";
        const reason = String(illegal.reason || "Illegal move attempt").split("|")[0].trim();
        const actor = formatActor(illegal.attemptedBy, illegal.expectedTurn);
        div.textContent = actor + " tried '" + illegal.moveInput + "' -> " + reason;
        illegalEl.appendChild(div);
      }
    }

    function renderRecap(game) {
      const ended = game.status !== "active";
      recapEl.classList.toggle("open", ended);
      if (!ended) {
        return;
      }

      illegalByModelEl.innerHTML = "";
      timingByModelEl.innerHTML = "";
      timingByTurnEl.innerHTML = "";

      const illegalSummary = summarizeByModel(game.illegalMoves || [], "attemptedBy");
      if (illegalSummary.length === 0) {
        const row = document.createElement("tr");
        createCell(row, "none");
        createCell(row, "0");
        illegalByModelEl.appendChild(row);
      } else {
        for (const [model, count] of illegalSummary) {
          const row = document.createElement("tr");
          createCell(row, model);
          createCell(row, String(count));
          illegalByModelEl.appendChild(row);
        }
      }

      const timingSummary = summarizeTimingByModel(game.history || []);
      if (timingSummary.length === 0) {
        const row = document.createElement("tr");
        createCell(row, "none");
        createCell(row, "0");
        createCell(row, "0 ms");
        createCell(row, "0 ms");
        createCell(row, "0 ms");
        timingByModelEl.appendChild(row);
      } else {
        for (const timing of timingSummary) {
          const row = document.createElement("tr");
          createCell(row, timing.model);
          createCell(row, String(timing.turns));
          createCell(row, formatMs(timing.total));
          createCell(row, formatMs(timing.average));
          createCell(row, formatMs(timing.slowest));
          timingByModelEl.appendChild(row);
        }
      }

      if (!Array.isArray(game.history) || game.history.length === 0) {
        const row = document.createElement("tr");
        createCell(row, "-");
        createCell(row, "-");
        createCell(row, "No moves");
        createCell(row, "-");
        createCell(row, "-");
        timingByTurnEl.appendChild(row);
        return;
      }

      for (const move of game.history) {
        const notes = [];
        if (move.thinking) notes.push(move.thinking);
        const row = document.createElement("tr");
        createCell(row, String(move.ply));
        createCell(row, String(move.by || "unknown-agent"));
        createCell(row, String(move.san || "?"));
        createCell(row, formatMs(Number(move.turnDurationMs || 0)));
        createCell(row, notes.length > 0 ? notes.join(" | ") : "-");
        timingByTurnEl.appendChild(row);
      }
    }

    function maxReplayPly(game) {
      if (!Array.isArray(game?.positions) || game.positions.length === 0) {
        return 0;
      }
      return Math.max(0, game.positions.length - 1);
    }

    function syncReplayControls(game, currentPly) {
      if (!replayControlsEl || !replayTimelineEl || !replayStatusEl) {
        return;
      }
      const shouldShow = game.status !== "active" && Array.isArray(game.positions) && game.positions.length > 1;
      replayControlsEl.classList.toggle("open", shouldShow);
      replayControlsEl.setAttribute("aria-hidden", shouldShow ? "false" : "true");
      if (!shouldShow) {
        replayTimelineEl.max = "0";
        replayTimelineEl.value = "0";
        replayStatusEl.textContent = "";
        return;
      }
      const maxPly = maxReplayPly(game);
      const clamped = Math.max(0, Math.min(maxPly, Number(currentPly) || 0));
      replayTimelineEl.max = String(maxPly);
      replayTimelineEl.value = String(clamped);
      replayStatusEl.textContent = "Move " + clamped + " / " + maxPly;
    }

    function renderNoActiveGame() {
      latestGame = null;
      replayIndex = null;
      document.title = "agent-chess Live View";
      outcomeEl.textContent = "";
      outcomeEl.style.display = "none";
      whiteSeatEl.classList.remove("active-turn");
      blackSeatEl.classList.remove("active-turn");
      renderSeat(blackSeatEl, "black", null, null, { status: "active", winner: null });
      renderSeat(whiteSeatEl, "white", null, null, { status: "active", winner: null });
      renderCaptureTitle(whiteCaptureTitleEl, null);
      renderCaptureTitle(blackCaptureTitleEl, null);
      renderCapturedRack(whiteCapturesEl, []);
      renderCapturedRack(blackCapturesEl, []);
      renderBoard("8/8/8/8/8/8/8/8 w - - 0 1", null);
      syncReplayControls({ status: "active", positions: [] }, 0);
      movesEl.innerHTML = "";
      appendEmpty(movesEl, "No active game.");
      illegalEl.innerHTML = "";
      appendEmpty(illegalEl, "No active game.");
      recapEl.classList.remove("open");
      illegalByModelEl.innerHTML = "";
      timingByModelEl.innerHTML = "";
      timingByTurnEl.innerHTML = "";
    }

    function hideGameSwitchBanner() {
      suggestedGameId = null;
      if (!gameSwitchBannerEl || !gameSwitchMessageEl) {
        return;
      }
      gameSwitchBannerEl.classList.remove("open");
      gameSwitchBannerEl.setAttribute("aria-hidden", "true");
      gameSwitchMessageEl.textContent = "";
    }

    function showGameSwitchBanner(newGameId) {
      if (!gameSwitchBannerEl || !gameSwitchMessageEl) {
        return;
      }
      suggestedGameId = newGameId;
      const currentLabel = latestGame?.id ? ("Game #" + friendlyGameNumber(latestGame.id)) : "the current game";
      const newLabel = "Game #" + friendlyGameNumber(newGameId);
      gameSwitchMessageEl.textContent = "New active game detected (" + newLabel + "). Currently viewing " + currentLabel + ".";
      gameSwitchBannerEl.classList.add("open");
      gameSwitchBannerEl.setAttribute("aria-hidden", "false");
    }

    function render(game) {
      const previousGame = latestGame;
      const white = game.playerModels?.white ?? null;
      const black = game.playerModels?.black ?? null;
      const gameNumber = friendlyGameNumber(game.id);
      const positions = Array.isArray(game.positions) && game.positions.length > 0
        ? game.positions
        : ["8/8/8/8/8/8/8/8 w - - 0 1"];
      const history = Array.isArray(game.history) ? game.history : [];
      const maxPly = Math.max(0, positions.length - 1);
      const gameChanged = previousGame?.id !== game.id;
      if (game.status === "active" || gameChanged || replayIndex === null) {
        replayIndex = maxPly;
      } else {
        replayIndex = Math.max(0, Math.min(maxPly, replayIndex));
      }
      const viewPly = Math.max(0, Math.min(maxPly, Number(replayIndex) || 0));
      const visibleHistory = history.slice(0, Math.min(viewPly, history.length));
      const viewedFen = positions[viewPly] ?? positions[maxPly];
      const latestMove = viewPly > 0 && viewPly - 1 < history.length
        ? history[viewPly - 1]
        : null;
      latestGame = game;

      document.title = "agent-chess Live View - Game #" + gameNumber;
      renderSeat(blackSeatEl, "black", black, latestThinkingForSide(visibleHistory, "black"), game);
      renderSeat(whiteSeatEl, "white", white, latestThinkingForSide(visibleHistory, "white"), game);
      renderCaptureTitle(whiteCaptureTitleEl, white);
      renderCaptureTitle(blackCaptureTitleEl, black);
      const outcome =
        game.status === "active" || game.status === "forfeit-illegal-moves"
          ? ""
          : game.resultText || "Game ended.";
      outcomeEl.textContent = outcome;
      outcomeEl.style.display = outcome ? "block" : "none";
      syncReplayControls(game, viewPly);

      if (game.status === "active") {
        if (visibleHistory.length > 0) {
          const lastMover = visibleHistory[visibleHistory.length - 1]?.side;
          whiteSeatEl.classList.toggle("active-turn", lastMover === "white");
          blackSeatEl.classList.toggle("active-turn", lastMover === "black");
        } else {
          whiteSeatEl.classList.remove("active-turn");
          blackSeatEl.classList.remove("active-turn");
        }
      } else {
        whiteSeatEl.classList.remove("active-turn");
        blackSeatEl.classList.remove("active-turn");
      }

      renderBoard(viewedFen, latestMove);
      renderCapturedPieces(game, viewPly);
      renderMoves(game, viewPly);
      renderIllegalAttempts(game);
      renderRecap(game);
    }

    async function refresh() {
      if (loading) {
        return;
      }
      loading = true;
      try {
        const endpoint = currentGameId
          ? "/api/game/" + encodeURIComponent(currentGameId)
          : "/api/live-game";
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Request failed with status " + response.status);
        }
        const payload = await response.json();
        const game = currentGameId ? payload : payload.game;
        if (!game) {
          renderNoActiveGame();
          hideGameSwitchBanner();
          return;
        }
        render(game);

        const liveResponse = await fetch("/api/live-game", { cache: "no-store" });
        if (!liveResponse.ok) {
          hideGameSwitchBanner();
          return;
        }
        const livePayload = await liveResponse.json();
        const liveGame = livePayload?.game ?? null;
        if (
          liveGame &&
          typeof liveGame.id === "string" &&
          liveGame.id !== game.id
        ) {
          showGameSwitchBanner(liveGame.id);
        } else {
          hideGameSwitchBanner();
        }
      } catch (error) {
        outcomeEl.textContent = error instanceof Error ? error.message : "Failed to fetch game state.";
        outcomeEl.style.display = "block";
        whiteSeatEl.classList.remove("active-turn");
        blackSeatEl.classList.remove("active-turn");
        hideGameSwitchBanner();
      } finally {
        loading = false;
      }
    }

    pollTimer = setInterval(() => {
      void refresh();
    }, config.pollMs);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    });

    if (replayTimelineEl) {
      replayTimelineEl.addEventListener("input", () => {
        if (!latestGame) {
          return;
        }
        replayIndex = Number(replayTimelineEl.value);
        render(latestGame);
      });
    }

    if (gameSwitchButtonEl) {
      gameSwitchButtonEl.addEventListener("click", () => {
        if (!suggestedGameId) {
          return;
        }
        currentGameId = suggestedGameId;
        config.gameId = suggestedGameId;
        replayIndex = null;
        hideGameSwitchBanner();
        void refresh();
      });
    }

    renderBoardAxes();
    void refresh();
  </script>
</body>
</html>
`;
}

export async function startLiveViewServer(store: Store, options: LiveViewOptions): Promise<LiveViewServer> {
  if (options.gameId) {
    await getGame(store, options.gameId);
  }
  const html = buildLiveHtml(options.gameId, options.pollMs);
  const inactivityPollMs = 3000;
  let closing = false;
  let inactivityTimer: NodeJS.Timeout | null = null;

  const closeServer = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    if (inactivityTimer) {
      clearInterval(inactivityTimer);
      inactivityTimer = null;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const server = createServer(async (req, res) => {
    if (closing) {
      writeJson(res, 503, { error: "Server shutting down." });
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const reqUrl = new URL(req.url ?? "/", "http://localhost");

    if (reqUrl.pathname === "/") {
      writeHtml(res, html);
      return;
    }

    if (reqUrl.pathname === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (reqUrl.pathname.startsWith("/api/game/")) {
      const requestedId = decodeURIComponent(reqUrl.pathname.slice("/api/game/".length));
      try {
        const game = await getGame(store, requestedId);
        writeJson(res, 200, game);
      } catch (error) {
        if (error instanceof CliError) {
          writeJson(res, 404, { error: error.message });
          return;
        }
        writeJson(res, 500, { error: "Failed to load game." });
      }
      return;
    }

    if (reqUrl.pathname === "/api/live-game") {
      try {
        const game = await resolveLiveGame(store, undefined);
        writeJson(res, 200, { game });
      } catch {
        writeJson(res, 500, { error: "Failed to load live game." });
      }
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Live view server did not return an address.");
  }

  const url = `http://${options.host}:${address.port}/`;

  if (options.exitOnInactive) {
    inactivityTimer = setInterval(() => {
      void (async () => {
        if (closing) {
          return;
        }
        try {
          const game = await resolveLiveGame(store, options.gameId);
          if (!game) {
            await closeServer();
            return;
          }
          if (game.status !== "active") {
            await closeServer();
          }
        } catch (error) {
          if (error instanceof CliError) {
            await closeServer();
          }
        }
      })();
    }, inactivityPollMs);
  }

  return {
    url,
    close: closeServer,
  };
}
