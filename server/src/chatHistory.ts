// Saved chat history: keeps each repo's conversations, so they survive a page reload or an app restart.
//
// Saved in data/chats/<owner>__<repo>.json, one file per repo:
//   { repoId, conversations: [ { id, title, createdAt, updatedAt, messages: [...] } ] }
// Why JSON and not SQLite: one user and small files, like the hotspots and reports. No native library to build.
//
// A question and its answer are saved together, once the answer has finished (appendExchange).
// Why: a half-streamed answer (page closed, AI error) is never saved.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import type { ChatMessage, Source } from "./types.js";
import type { Usage } from "./usage.js";

const CHATS_DIR = path.join(DATA_DIR, "chats");

/** Most conversations kept per repo. Why: the file stays small; the least recently used ones go first. */
export const MAX_CONVERSATIONS = 50;
/** Most messages kept per conversation (oldest go first). */
export const MAX_MESSAGES = 400;
/** Longest title, taken from the first question. */
const TITLE_LENGTH = 60;

/** One saved message: the chat message plus what the app shows with it. */
export interface SavedMessage extends ChatMessage {
  sources?: Source[]; // answers: the code the AI was given (for citation links)
  followUps?: string[]; // answers: the suggested next questions
  usage?: Usage; // answers: AI tokens used
  scope?: string; // questions: the "Search in" folder or file, if one was picked
  at: string; // when it was saved
}

export interface Conversation {
  id: string;
  title: string; // the first question, shortened
  createdAt: string;
  updatedAt: string;
  messages: SavedMessage[];
}

/** What the "Past chats" list shows: no messages, so it stays small. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface RepoChats {
  repoId: string;
  conversations: Conversation[];
}

/** Conversation ids are made here (UUIDs). Why check them: the id comes back from the browser. */
const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** A new conversation id. */
export function newConversationId(): string {
  return randomUUID();
}

/** The title for a conversation: its first question on one line, cut to 60 characters. */
export function titleFrom(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length <= TITLE_LENGTH ? oneLine : `${oneLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

// ---------- Reading and writing the file ----------

/** Where a repo's chats are saved, e.g. data/chats/octo__hello.json. */
function chatsPath(repoId: string): string {
  return path.join(CHATS_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Reads a repo's chats. An empty list if there are none yet. */
async function load(repoId: string): Promise<RepoChats> {
  try {
    return JSON.parse(await readFile(chatsPath(repoId), "utf8")) as RepoChats;
  } catch {
    return { repoId, conversations: [] };
  }
}

/** Saves a repo's chats. Writes a temporary file, then renames it. Why: a crash mid-write can't leave a broken file. */
async function save(chats: RepoChats): Promise<void> {
  await mkdir(CHATS_DIR, { recursive: true });
  const file = chatsPath(chats.repoId);
  await writeFile(`${file}.tmp`, JSON.stringify(chats));
  await rename(`${file}.tmp`, file);
}

// Changes to one repo's file, one at a time. Why: two answers finishing together (e.g. two tabs)
// would otherwise both read the old file, and one would overwrite the other's save.
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(repoId: string, change: () => Promise<T>): Promise<T> {
  const next = (queues.get(repoId) ?? Promise.resolve()).then(change, change);
  queues.set(repoId, next.catch(() => undefined));
  return next;
}

// ---------- What the rest of the app uses ----------

/** The repo's conversations for the "Past chats" list, most recent first. */
export async function listConversations(repoId: string): Promise<ConversationSummary[]> {
  const { conversations } = await load(repoId);
  return conversations
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One conversation with all its messages, or null if there's no such conversation. */
export async function getConversation(repoId: string, id: string): Promise<Conversation | null> {
  const { conversations } = await load(repoId);
  return conversations.find((c) => c.id === id) ?? null;
}

/**
 * Saves a finished question and answer. Creates the conversation if it doesn't exist yet
 * (its title is the question). Keeps at most MAX_CONVERSATIONS and MAX_MESSAGES.
 */
export function appendExchange(
  repoId: string,
  conversationId: string,
  question: Omit<SavedMessage, "role" | "at">,
  reply: Omit<SavedMessage, "role" | "at">,
): Promise<Conversation> {
  return oneAtATime(repoId, async () => {
    const chats = await load(repoId);
    const now = new Date().toISOString();
    let conversation = chats.conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      conversation = { id: conversationId, title: titleFrom(question.content), createdAt: now, updatedAt: now, messages: [] };
      chats.conversations.push(conversation);
    }
    conversation.messages.push({ ...question, role: "user", at: now }, { ...reply, role: "assistant", at: now });
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES);
    conversation.updatedAt = now;

    // Too many? Drop the ones used least recently.
    chats.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    chats.conversations = chats.conversations.slice(0, MAX_CONVERSATIONS);
    await save(chats);
    return conversation;
  });
}

/** Deletes one conversation. Returns false if it didn't exist. */
export async function deleteConversation(repoId: string, id: string): Promise<boolean> {
  return (await deleteConversations(repoId, [id])) === 1;
}

/**
 * Deletes several conversations ("Delete selected" in Past chats). Returns how many were deleted.
 * Why one save for all: a failure can't leave some deleted and some not.
 */
export function deleteConversations(repoId: string, ids: string[]): Promise<number> {
  return oneAtATime(repoId, async () => {
    const chats = await load(repoId);
    const remove = new Set(ids);
    const before = chats.conversations.length;
    chats.conversations = chats.conversations.filter((c) => !remove.has(c.id));
    const deleted = before - chats.conversations.length;
    if (deleted > 0) await save(chats);
    return deleted;
  });
}
