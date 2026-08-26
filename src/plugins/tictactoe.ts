import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Tic-tac-toe you can play against the bot in Telegram. The game is set up by a
// tool call (`play_tic_tac_toe`); the bot renders the board as a Telegram
// message with an inline keyboard of tappable empty cells. Tapping a cell
// comes back through the messenger's "action" path (see getMessengers in
// agent.ts, where `respondTo` includes "action"), arriving to the model as a
// user message of the form "Action selected: ttt_move\nValue: <cell>"; the
// model relays it back to this tool as a move. No credential or external
// service is involved, so the plugin is on by default — disable with
// ENABLE_TICTACTOE=false.

// --- Pure game logic ------------------------------------------------------
//
// Kept pure (no Worker/Bot API) so it is unit-tested without the network. The
// tool below composes these helpers with the Telegram send.

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = Cell[];

/** The eight winning triples on a 3×3 board indexed 0–8. */
export const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function createEmptyBoard(): Board {
  return Array(9).fill(null);
}

/** The mark that fills a winning line, or null if none. */
export function winner(board: Board): Mark | null {
  for (const [a, b, c] of WIN_LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v;
  }
  return null;
}

export function isFull(board: Board): boolean {
  return board.every((c) => c !== null);
}

export function availableMoves(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) if (!board[i]) out.push(i);
  return out;
}

/** Return a NEW board with `mark` placed at `cell` (caller validates emptiness). */
export function applyMove(board: Board, cell: number, mark: Mark): Board {
  const next = board.slice();
  next[cell] = mark;
  return next;
}

/**
 * The bot's move (it plays O). Minimax with alpha-beta, picking randomly among
 * equally-best moves so the same opening does not always produce the same game
 * (otherwise the optimal second player draws every time, which is dull). With
 * optimal play O never loses; the random tie-break only varies which optimal
 * line is taken. Returns -1 if there is nowhere to move.
 */
export function botMove(board: Board): number {
  const moves = availableMoves(board);
  if (moves.length === 0) return -1;
  let best = -Infinity;
  const scored: Array<{ cell: number; score: number }> = [];
  for (const cell of moves) {
    const score = minimax(applyMove(board, cell, "O"), 0, false, -Infinity, Infinity);
    scored.push({ cell, score });
    if (score > best) best = score;
  }
  const bestMoves = scored.filter((m) => m.score === best).map((m) => m.cell);
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

// Minimax scoring from O's perspective: + when O wins, - when X wins, scaled
// by depth so faster wins and slower losses are preferred. `isMax` is true on
// O's turns (the maximiser).
function minimax(
  board: Board,
  depth: number,
  isMax: boolean,
  alpha: number,
  beta: number,
): number {
  const w = winner(board);
  if (w === "O") return 10 - depth;
  if (w === "X") return depth - 10;
  if (isFull(board)) return 0;
  const moves = availableMoves(board);
  if (isMax) {
    let value = -Infinity;
    for (const cell of moves) {
      value = Math.max(
        value,
        minimax(applyMove(board, cell, "O"), depth + 1, false, alpha, beta),
      );
      alpha = Math.max(alpha, value);
      if (beta <= alpha) break;
    }
    return value;
  }
  let value = Infinity;
  for (const cell of moves) {
    value = Math.min(
      value,
      minimax(applyMove(board, cell, "X"), depth + 1, true, alpha, beta),
    );
    beta = Math.min(beta, value);
    if (beta <= alpha) break;
  }
  return value;
}

/**
 * A monospace-friendly text rendering of the board: empty cells show their
 * 1-based position so the user can match them to the tappable buttons (whose
 * labels are the same 1-based numbers). Rendered inside a Telegram <pre> so
 * the grid stays aligned.
 */
export function renderBoard(board: Board): string {
  const rows = [0, 3, 6].map((start) =>
    [start, start + 1, start + 2]
      .map((i) => board[i] ?? String(i + 1))
      .join(" | "),
  );
  return rows.join("\n─────────\n");
}

// --- Telegram inline keyboard -------------------------------------------

/** Callback-data encoding compatible with the @chat-adapter/telegram decoder. */
export const TTT_ACTION = "ttt_move";

/**
 * Encode a cell (0-based) into a Telegram `callback_data` the messenger's
 * action path decodes into `actionId = "ttt_move"`, `value = "<cell>"`. The
 * adapter prefixes payloads with "chat:" and JSON-encodes `{ a, v }`; we mirror
 * that so `decodeTelegramCallbackData` recovers a clean value for the model.
 */
export function encodeTttCallback(cell: number): string {
  return `chat:${JSON.stringify({ a: TTT_ACTION, v: String(cell) })}`;
}

export interface TttButton {
  text: string;
  callback_data: string;
}

/**
 * Build an inline keyboard of ONLY the empty cells (filled cells are shown as
 * marks in the board text, never as buttons — a filled cell can't be re-played,
 * and the messenger turns ANY callback query into a turn, so we avoid wasted
 * turns on already-taken cells). Buttons are chunked into rows of 3.
 */
export function buildInlineKeyboard(board: Board): TttButton[][] {
  const buttons: TttButton[] = [];
  for (let i = 0; i < 9; i++) {
    if (!board[i]) {
      buttons.push({ text: String(i + 1), callback_data: encodeTttCallback(i) });
    }
  }
  const rows: TttButton[][] = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return rows;
}

// --- Game state ----------------------------------------------------------

/** Durable-storage key for the active per-chat game (one game at a time). */
export const TTT_GAME_KEY = "ttt_game";

export type GameStatus = "playing" | "won" | "lost" | "draw";

export interface TicTacToeGame {
  /** 9 cells, index 0–8 left-to-right, top-to-bottom. */
  board: Board;
  /** Whose turn next. "X" = the user; "O" = the bot. */
  next: Mark;
  status: GameStatus;
  /** Set when a player completes a line. */
  winner?: Mark;
  /** Telegram message_id of the board message carrying the live buttons. */
  boardMessageId?: number;
}

/** A one-line status caption shown under the board. */
export function statusCaption(game: TicTacToeGame): string {
  switch (game.status) {
    case "won":
      return "🎉 You win!";
    case "lost":
      return "😏 I win — better luck next time.";
    case "draw":
      return "🤝 It's a draw.";
    case "playing":
      return game.next === "X" ? "Your move — tap a number." : "Thinking…";
  }
}

/** The full HTML body of a board message (board in <pre>, caption below). */
export function gameMessage(game: TicTacToeGame): string {
  return `<b>Tic-tac-toe</b>\nYou are ❌, I am ⭕.\n\n<pre>${renderBoard(game.board)}</pre>\n\n${statusCaption(game)}`;
}

// --- Telegram Bot API helper --------------------------------------------

const TG_API_BASE = "https://api.telegram.org";
// A hanging outbound fetch would stall the chat turn (the stall watchdog
// would eventually recover it, but only after a long frozen gap), so every
// Bot API call here is bounded — fail fast and let the tool return a clean
// error instead.
const TG_TIMEOUT_MS = 8_000;

interface TelegramResult {
  message_id?: number;
}

async function tgPost(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResult | undefined> {
  try {
    const res = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TelegramResult;
      description?: string;
    };
    if (!data.ok) {
      console.error(`tellboy: ttt ${method} failed`, data.description ?? res.status);
      return undefined;
    }
    return data.result;
  } catch (err) {
    console.error(`tellboy: ttt ${method} threw`, String(err));
    return undefined;
  }
}

// The structured object the tool returns to the model, so it can narrate the
// game state without re-reading the board off the chat.
function gameSummary(game: TicTacToeGame) {
  return {
    status: game.status,
    next: game.status === "playing" ? game.next : undefined,
    winner: game.winner,
    board: renderBoard(game.board),
    boardSent: game.boardMessageId !== undefined,
  };
}

// --- Plugin ---------------------------------------------------------------

/**
 * Play tic-tac-toe against the bot in Telegram. The board is rendered in chat
 * with tappable number buttons for each empty cell; tapping one comes back to
 * the model as a "ttt_move" action and is replayed here as a move. The bot
 * (⭕) plays optimally with minimax. No external dependency, so enabled by
 * default; disable with ENABLE_TICTACTOE=false.
 */
export const tictactoePlugin: Plugin = {
  name: "tictactoe",

  isEnabled(env) {
    return envFlag(env, "tictactoe") ?? true;
  },

  tools(agent: TellboyAgent, env: Env): ToolSet {
    // The live Telegram chat target for a direct Bot API send of the board.
    // Resolved per call from the messenger context (the tool runs inside a
    // chat turn), mirroring how the reminders plugin captures the chat id.
    const target = () => agent.currentTelegramTarget();

    // Remove the buttons from a board message so the user can't tap a move
    // that has already been played / a game that has ended. Best-effort.
    const clearButtons = async (chatId: string, messageId?: number) => {
      if (messageId === undefined) return;
      await tgPost(env.TELEGRAM_BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    };

    // Render the current board as a fresh message with live buttons and
    // remember its message_id so it can be cleared on the next move / end.
    const sendBoard = async (
      chatId: string,
      messageThreadId: number | undefined,
      game: TicTacToeGame,
    ): Promise<number | undefined> => {
      const result = await tgPost(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
        text: gameMessage(game),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildInlineKeyboard(game.board) },
      });
      return result?.message_id;
    };

    return {
      play_tic_tac_toe: tool({
        description:
          "Play tic-tac-toe against the bot. The bot (⭕) replies with a board " +
          "rendered in the chat as tappable number buttons; the user is ❌ and " +
          "moves first. Use action='start' to begin a game, action='move' with " +
          "cell (0–8) to play the user's move (the bot then moves automatically), " +
          "action='status' to read the current game, and action='resign' to end " +
          "it.\n\nWhen the user taps a board button you receive a user message " +
          "containing 'Action selected: ttt_move' and a 'Value: N' line; that N " +
          "is the 0-based cell index — call this tool again with action='move' " +
          "and cell=N. Do not echo the raw action text to the user; just play the " +
          "move and describe the result briefly.",
        inputSchema: z.object({
          action: z
            .enum(["start", "move", "status", "resign"])
            .describe("What to do: start a new game, play a move, check status, or end the game."),
          cell: z
            .number()
            .int()
            .min(0)
            .max(8)
            .optional()
            .describe(
              "Required for action='move': the 0-based cell index to play " +
                "(exactly the Value N received from a ttt_move button action).",
            ),
        }),
        execute: async ({ action, cell }) => {
          const t = target();

          // --- start -----------------------------------------------------
          if (action === "start") {
            if (!t) {
              return { error: "I can't resolve this chat to send the board to." };
            }
            const game: TicTacToeGame = {
              board: createEmptyBoard(),
              next: "X",
              status: "playing",
            };
            const messageId = await sendBoard(t.chatId, t.messageThreadId, game);
            if (messageId === undefined) {
              return { error: "Couldn't send the game board to Telegram." };
            }
            game.boardMessageId = messageId;
            await agent.setTicTacToeGame(game);
            return {
              ok: true,
              ...gameSummary(game),
              note: "Board sent to chat with move buttons. Wait for the user to tap a cell.",
            };
          }

          // --- status ----------------------------------------------------
          if (action === "status") {
            const game = await agent.getTicTacToeGame();
            if (!game) return { status: "none", note: "No active game." };
            return gameSummary(game);
          }

          // --- resign ----------------------------------------------------
          if (action === "resign") {
            const game = await agent.getTicTacToeGame();
            if (game && t) await clearButtons(t.chatId, game.boardMessageId);
            await agent.setTicTacToeGame(undefined);
            return { ok: true, status: "resigned" };
          }

          // --- move ------------------------------------------------------
          if (action !== "move") {
            return { error: `Unknown action: ${action}.` };
          }

          const game = await agent.getTicTacToeGame();
          if (!game) {
            return {
              error: "No active tic-tac-toe game. Start one with action='start'.",
            };
          }
          if (game.status !== "playing") {
            return {
              error: `The game is already over (${game.status}). Start a new one with action='start'.`,
              ...gameSummary(game),
            };
          }
          if (cell === undefined) {
            return { error: "A cell (0–8) is required for a move." };
          }
          if (cell < 0 || cell > 8) {
            return { error: `cell must be 0–8, got ${cell}.` };
          }
          if (game.board[cell] !== null) {
            return {
              error: `Cell ${cell} is already taken.`,
              ...gameSummary(game),
            };
          }

          // User's move (X).
          game.board = applyMove(game.board, cell, "X");
          let w = winner(game.board);
          if (w === "X") {
            game.status = "won";
            game.winner = "X";
          } else if (isFull(game.board)) {
            game.status = "draw";
          } else {
            // Bot's move (O) — minimax, never loses.
            const move = botMove(game.board);
            if (move >= 0) {
              game.board = applyMove(game.board, move, "O");
              w = winner(game.board);
              if (w === "O") {
                game.status = "lost";
                game.winner = "O";
              } else if (isFull(game.board)) {
                game.status = "draw";
              } else {
                game.next = "X";
              }
            } else {
              game.status = "draw";
            }
          }

          // Re-render the board: clear the old buttons, then (if the game is
          // still live) post a fresh message with the new buttons. On game
          // over we leave the final board (buttons removed) and let the model
          // narrate the result.
          if (t) {
            await clearButtons(t.chatId, game.boardMessageId);
            if (game.status === "playing") {
              const messageId = await sendBoard(
                t.chatId,
                t.messageThreadId,
                game,
              );
              game.boardMessageId = messageId;
            } else {
              game.boardMessageId = undefined;
            }
          }

          await agent.setTicTacToeGame(game);
          return {
            ok: true,
            ...gameSummary(game),
            note:
              game.status === "playing"
                ? "Board updated; wait for the user's next tap."
                : undefined,
          };
        },
      }),
    };
  },
};
