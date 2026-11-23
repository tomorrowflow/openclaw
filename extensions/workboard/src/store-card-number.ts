import {
  WORKBOARD_CARD_KINDS,
  type WorkboardCard,
  type WorkboardCardKind,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardCardPatch, WorkboardLinkedCreateInput } from "./store-inputs.js";
import { normalizeTitle } from "./store-normalizers.js";

type CardIdentity = Pick<WorkboardCard, "title" | "kind" | "release" | "seq">;
/** The store as the numbering reads it: board keys and every card. */
type CardNumberReader = {
  boardKey(boardId: string): Promise<string | undefined>;
  list(): Promise<readonly WorkboardCard[]>;
};

/** A task is stored without a kind; `undefined` keeps `fallback`. */
export function normalizeCardKind(
  value: unknown,
  fallback?: WorkboardCardKind,
): WorkboardCardKind | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (value === null || value === "task") {
    return undefined;
  }
  if (!WORKBOARD_CARD_KINDS.includes(value as WorkboardCardKind)) {
    throw new Error(`card kind must be one of ${WORKBOARD_CARD_KINDS.join(", ")}.`);
  }
  return value as WorkboardCardKind;
}

export type WorkboardCardNumber = { release: number; seq: number };
/**
 * A card's number with the ID it shows. A retro has no release; a numbered
 * card whose board lost its key keeps its number without an ID.
 */
type BoardCardNumber = { ref?: string; release?: number; seq: number };

export function cardRef(key: string, number: WorkboardCardNumber): string {
  return `${key}-${number.release}.${String(number.seq).padStart(2, "0")}`;
}

/**
 * The title with the card's ID in front, replacing any `[...]` tag it led
 * with. The length limit applies to the text, so the ID never pushes a title
 * over it, and an edit that sends the prefixed title back is measured the same.
 */
export function withRefTitle(title: unknown, ref: string): string {
  return `[${ref}] ${normalizeTitle(withoutRefTag(title))}`;
}

function withoutRefTag(title: unknown): unknown {
  return typeof title === "string" ? title.trim().replace(/^\[[^\]\n]{1,40}\]\s*/, "") : title;
}

function numberOption(value: unknown, field: string, min: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = resolveOptionalIntegerOption(value, { min, max: 9999 });
  if (number === undefined) {
    throw new Error(`${field} must be a whole number of at least ${min}.`);
  }
  return number;
}

/**
 * The number a card gets on a board with a key. A spec opens the next release
 * as `.00`; any other card joins the highest release (1 on a board without
 * numbered cards) after its highest number. An explicit `seq` places a spec's
 * ticket at its file number; an explicit `release` is the operator's. Archived
 * cards keep their numbers, so no number is ever handed out twice.
 */
export function assignCardNumber(params: {
  cards: readonly WorkboardCard[];
  boardId: string;
  cardId?: string;
  kind: WorkboardCardKind | undefined;
  release?: unknown;
  seq?: unknown;
}): WorkboardCardNumber {
  const numbered = params.cards.filter(
    (card) =>
      card.id !== params.cardId &&
      cardBoardId(card) === params.boardId &&
      card.release !== undefined &&
      card.seq !== undefined,
  );
  const current = Math.max(0, ...numbered.map((card) => card.release ?? 0));
  const release =
    numberOption(params.release, "release", 1) ??
    (params.kind === "spec" ? current + 1 : Math.max(current, 1));
  const inRelease = numbered.filter((card) => card.release === release);
  const seq =
    numberOption(params.seq, "seq", 0) ??
    (inRelease.length
      ? Math.max(...inRelease.map((card) => card.seq ?? 0)) + 1
      : params.kind === "spec"
        ? 0
        : 1);
  const taken = inRelease.find((card) => card.seq === seq);
  if (taken) {
    throw new Error(`number ${release}.${seq} is already taken by card ${taken.id}.`);
  }
  return { release, seq };
}

function retroRef(seq: number): string {
  return `RETRO-${seq}`;
}

/** Retros count on their own on every board, keyed or not, outside any release. */
function retroCardNumber(params: {
  cards: readonly WorkboardCard[];
  boardId: string;
  release?: unknown;
  seq?: unknown;
  cardId?: string;
}): BoardCardNumber {
  if (params.release !== undefined || params.seq !== undefined) {
    throw new Error("a retro card is numbered RETRO-<n> by its board; it takes no release or seq.");
  }
  const seq =
    1 +
    Math.max(
      0,
      ...params.cards
        .filter(
          (card) =>
            card.id !== params.cardId &&
            card.kind === "retro" &&
            cardBoardId(card) === params.boardId,
        )
        .map((card) => card.seq ?? 0),
    );
  return { ref: retroRef(seq), seq };
}

/** Cards on a board without a key stay unnumbered, and cannot be given a number. */
async function boardCardNumber(params: {
  cards: readonly WorkboardCard[];
  boardId: string;
  reader: CardNumberReader;
  kind: WorkboardCardKind | undefined;
  release?: unknown;
  seq?: unknown;
  cardId?: string;
}): Promise<BoardCardNumber | undefined> {
  if (params.kind === "retro") {
    return retroCardNumber(params);
  }
  const key = await params.reader.boardKey(params.boardId);
  if (!key) {
    if (params.release !== undefined || params.seq !== undefined) {
      throw new Error(`board ${params.boardId} has no key, so its cards are not numbered.`);
    }
    return undefined;
  }
  const number = assignCardNumber(params);
  return { ref: cardRef(key, number), ...number };
}

async function keptCardNumber(
  reader: CardNumberReader,
  card: WorkboardCard,
  boardId: string,
): Promise<BoardCardNumber | undefined> {
  if (card.seq === undefined) {
    return undefined;
  }
  if (card.kind === "retro") {
    return { ref: retroRef(card.seq), seq: card.seq };
  }
  if (card.release === undefined) {
    return undefined;
  }
  const number = { release: card.release, seq: card.seq };
  const key = await reader.boardKey(boardId);
  return key ? { ref: cardRef(key, number), ...number } : number;
}

function identityOf(
  title: unknown,
  kind: WorkboardCardKind | undefined,
  number: BoardCardNumber | undefined,
): CardIdentity {
  return {
    title: number?.ref ? withRefTitle(title, number.ref) : normalizeTitle(title),
    ...(kind ? { kind } : {}),
    ...(number ? { release: number.release, seq: number.seq } : {}),
  };
}

export async function newCardIdentity(
  reader: CardNumberReader,
  params: {
    cards: readonly WorkboardCard[];
    boardId: string;
    input: Pick<WorkboardLinkedCreateInput, "title" | "kind" | "release" | "seq">;
    /** A probe is a copy of a numbered card, not a card of its own release. */
    probe?: unknown;
  },
): Promise<CardIdentity> {
  const { cards, boardId, input } = params;
  const kind = normalizeCardKind(input.kind);
  if (params.probe) {
    return identityOf(input.title, kind, undefined);
  }
  const number = await boardCardNumber({
    cards,
    boardId,
    reader,
    kind,
    release: input.release,
    seq: input.seq,
  });
  return identityOf(input.title, kind, number);
}

/**
 * Kind and number are what a card is; they change only before it first
 * starts. A numbered card keeps its ID in front of any new title.
 */
export async function updatedCardIdentity(
  reader: CardNumberReader,
  existing: WorkboardCard,
  patch: WorkboardCardPatch,
): Promise<CardIdentity> {
  const kind = normalizeCardKind(patch.kind, existing.kind);
  // A retro and a release ticket are numbered apart, so crossing between them renumbers.
  const crossesRetro = (kind === "retro") !== (existing.kind === "retro");
  const renumber = patch.release !== undefined || patch.seq !== undefined || crossesRetro;
  if ((kind !== existing.kind || renumber) && existing.startedAt) {
    throw new Error("a card's kind and number are fixed once it has started.");
  }
  if (patch.title === undefined && !renumber) {
    return { title: existing.title, kind, release: existing.release, seq: existing.seq };
  }
  const boardId = cardBoardId(existing);
  const number = renumber
    ? await boardCardNumber({
        cards: await reader.list(),
        boardId,
        reader,
        kind,
        release: patch.release ?? (crossesRetro ? undefined : existing.release),
        seq: patch.seq ?? (crossesRetro ? undefined : existing.seq),
        cardId: existing.id,
      })
    : await keptCardNumber(reader, existing, boardId);
  // Every field explicit: the patch spreads over the existing card, so an absent kind must clear it.
  // A card leaving the retro numbering for a board without a key drops its RETRO-<n> tag.
  const title = patch.title ?? existing.title;
  return {
    ...identityOf(crossesRetro && !number ? withoutRefTag(title) : title, kind, number),
    kind,
    release: number?.release,
    seq: number?.seq,
  };
}
