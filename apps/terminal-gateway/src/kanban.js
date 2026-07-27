// Kanban store for the pluggable Kanban-board artifact feature.
//
// STATE, not config: lives in a gitignored data/kanban.json sidecar (the same
// data/ dir as sessions.json). Mirrors registry.js / metadata.js: a module-level
// store, load() at module bottom, atomic persist() (writeFileSync(TMP) +
// renameSync over the live file), and a missing/corrupt file degrades to an
// empty store rather than crashing.
//
// CONCURRENCY (see docs/KANBAN-PLAN.md D3): every mutator here is FULLY
// SYNCHRONOUS (read -> modify -> writeFileSync, no await mid-method), so Node's
// single thread runs each to completion without interleaving — a read-modify-
// write is therefore atomic and no mutex is required (same reason registry.js
// needs none). Cross-CLIENT staleness (a human dragging a card off a 10-second-
// old view while the agent moves the same card) is handled by a monotonic
// per-board `rev`: moveCard() rejects a stale expectedRev with an error coded
// "stale", which the gateway maps to HTTP 409.
//
// ORDERING (D4): Column.cardIds[] is the SOLE source of truth for card order and
// column membership. A card record carries no columnId/order; getBoard() derives
// a per-card `columnId` for consumers but never persists it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// Overridable for tests via KANBAN_FILE (mirrors SERVERS_FILE in registry.js).
const FILE = process.env.KANBAN_FILE || path.join(DATA_DIR, "kanban.json");
const TMP = `${FILE}.tmp`;

const DEFAULT_COLUMNS = ["Backlog", "To Do", "In Progress", "Done"];

// { boards: { [boardId]: Board } } where a stored Board is
// { id, name, tags[], rev, createdAt, updatedAt, columns[], cards{} } and
// cards is a map id -> { id, title, description, tags[], createdAt, updatedAt }.
let store = { boards: {} };

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Coded error the gateway can map to an HTTP status.
function err(code, message) {
  const e = new Error(message || code);
  e.code = code; // "not_found" | "bad_request" | "stale"
  return e;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    store =
      parsed && typeof parsed === "object" && parsed.boards
        ? { boards: parsed.boards }
        : { boards: {} };
  } catch {
    store = { boards: {} };
  }
  return store;
}

function persist() {
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(TMP, json, "utf8");
  fs.renameSync(TMP, FILE);
}

function requireBoard(boardId) {
  const board = store.boards[boardId];
  if (!board) throw err("not_found", "board not found");
  return board;
}

// Bump rev + updatedAt on a mutation of `board`.
function touch(board) {
  board.rev += 1;
  board.updatedAt = now();
}

// ---- Read shapes ----

// Full board with cards as an array, each carrying a DERIVED columnId. Returns
// a deep copy so callers can never mutate the store.
function shapeBoard(board) {
  const columnOf = {};
  for (const col of board.columns) {
    for (const cid of col.cardIds) columnOf[cid] = col.id;
  }
  return {
    id: board.id,
    name: board.name,
    tags: [...board.tags],
    rev: board.rev,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columns: board.columns.map((c) => ({
      id: c.id,
      name: c.name,
      cardIds: [...c.cardIds],
    })),
    cards: Object.values(board.cards).map((card) => ({
      id: card.id,
      title: card.title,
      description: card.description,
      tags: [...card.tags],
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      columnId: columnOf[card.id],
    })),
  };
}

function shapeSummary(board) {
  return {
    id: board.id,
    name: board.name,
    tags: [...board.tags],
    rev: board.rev,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columnCount: board.columns.length,
    cardCount: Object.keys(board.cards).length,
  };
}

function listBoards() {
  return Object.values(store.boards)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(shapeSummary);
}

function getBoard(boardId) {
  const board = store.boards[boardId];
  return board ? shapeBoard(board) : undefined;
}

// ---- Mutators (synchronous => atomic; each persists) ----

function createBoard({ name, tags = [], columns } = {}) {
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  const ts = now();
  const colNames =
    Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
  const board = {
    id: newId("kb"),
    name,
    tags: Array.isArray(tags) ? [...tags] : [],
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
    columns: colNames.map((n) => ({ id: newId("col"), name: n, cardIds: [] })),
    cards: {},
  };
  store.boards[board.id] = board;
  persist();
  return shapeBoard(board);
}

function updateBoard(boardId, { name, tags } = {}) {
  const board = requireBoard(boardId);
  if (name !== undefined) board.name = name;
  if (tags !== undefined) board.tags = [...tags];
  touch(board);
  persist();
  return shapeBoard(board);
}

function deleteBoard(boardId) {
  if (!store.boards[boardId]) return false;
  delete store.boards[boardId];
  persist();
  return true;
}

function createCard(
  boardId,
  { title, description = "", tags = [], columnId } = {},
) {
  const board = requireBoard(boardId);
  if (!title || typeof title !== "string")
    throw err("bad_request", "title required");
  const column = columnId
    ? board.columns.find((c) => c.id === columnId)
    : board.columns[0];
  if (!column) throw err("not_found", "column not found");
  const ts = now();
  const card = {
    id: newId("card"),
    title,
    description: typeof description === "string" ? description : "",
    tags: Array.isArray(tags) ? [...tags] : [],
    createdAt: ts,
    updatedAt: ts,
  };
  board.cards[card.id] = card;
  column.cardIds.push(card.id);
  touch(board);
  persist();
  return { ...card, tags: [...card.tags], columnId: column.id };
}

function updateCard(boardId, cardId, { title, description, tags } = {}) {
  const board = requireBoard(boardId);
  const card = board.cards[cardId];
  if (!card) throw err("not_found", "card not found");
  if (title !== undefined) card.title = title;
  if (description !== undefined) card.description = description;
  if (tags !== undefined) card.tags = [...tags];
  card.updatedAt = now();
  touch(board);
  persist();
  const columnId = board.columns.find((c) => c.cardIds.includes(cardId))?.id;
  return { ...card, tags: [...card.tags], columnId };
}

// D5: the crispest contract. Splice out of the source column, splice into the
// target at a clamped index, one write. `expectedRev` gives optimistic
// concurrency: a mismatch throws "stale" (gateway -> 409 + current board).
function moveCard(boardId, cardId, { toColumnId, toIndex, expectedRev } = {}) {
  const board = requireBoard(boardId);
  if (expectedRev !== undefined && expectedRev !== board.rev)
    throw err("stale", "board revision is stale");
  if (!board.cards[cardId]) throw err("not_found", "card not found");
  const source = board.columns.find((c) => c.cardIds.includes(cardId));
  if (!source) throw err("not_found", "card not found in any column");
  const target = board.columns.find((c) => c.id === toColumnId);
  if (!target) throw err("not_found", "target column not found");
  // Splice out of source.
  source.cardIds.splice(source.cardIds.indexOf(cardId), 1);
  // Clamp destination index and splice in.
  const idx = Math.max(
    0,
    Math.min(Number(toIndex) || 0, target.cardIds.length),
  );
  target.cardIds.splice(idx, 0, cardId);
  touch(board);
  persist();
  return shapeBoard(board);
}

function deleteCard(boardId, cardId) {
  const board = requireBoard(boardId);
  if (!board.cards[cardId]) return false;
  delete board.cards[cardId];
  for (const col of board.columns) {
    const i = col.cardIds.indexOf(cardId);
    if (i >= 0) col.cardIds.splice(i, 1);
  }
  touch(board);
  persist();
  return true;
}

load();

export default {
  load,
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  createCard,
  updateCard,
  moveCard,
  deleteCard,
};
