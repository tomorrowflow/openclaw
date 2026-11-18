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
type BoardKey = (boardId: string) => Promise<string | undefined>;

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

export function cardRef(key: string, number: WorkboardCardNumber): string {
  return `${key}-${number.release}.${String(number.seq).padStart(2, "0")}`;
}

/** The title with the card's ID in front, replacing any `[...]` tag it already led with. */
export function withRefTitle(title: string, ref: string): string {
  return `[${ref}] ${title.replace(/^\[[^\]\n]{1,40}\]\s*/, "")}`;
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

/** Cards on a board without a key stay unnumbered, and cannot be given a number. */
async function boardCardNumber(params: {
  cards: readonly WorkboardCard[];
  boardId: string;
  boardKey: BoardKey;
  kind: WorkboardCardKind | undefined;
  release?: unknown;
  seq?: unknown;
  cardId?: string;
}): Promise<(WorkboardCardNumber & { key: string }) | undefined> {
  const key = await params.boardKey(params.boardId);
  if (!key) {
    if (params.release !== undefined || params.seq !== undefined) {
      throw new Error(`board ${params.boardId} has no key, so its cards are not numbered.`);
    }
    return undefined;
  }
  return { key, ...assignCardNumber(params) };
}

function identityOf(
  title: string,
  kind: WorkboardCardKind | undefined,
  number: (WorkboardCardNumber & { key?: string }) | undefined,
): CardIdentity {
  return {
    title: number?.key ? withRefTitle(title, cardRef(number.key, number)) : title,
    ...(kind ? { kind } : {}),
    ...(number ? { release: number.release, seq: number.seq } : {}),
  };
}

export async function newCardIdentity(params: {
  cards: readonly WorkboardCard[];
  boardId: string;
  boardKey: BoardKey;
  input: Pick<WorkboardLinkedCreateInput, "title" | "kind" | "release" | "seq">;
}): Promise<CardIdentity> {
  const kind = normalizeCardKind(params.input.kind);
  const { cards, boardId, boardKey, input } = params;
  const number = await boardCardNumber({
    cards,
    boardId,
    boardKey,
    kind,
    release: input.release,
    seq: input.seq,
  });
  return identityOf(normalizeTitle(input.title), kind, number);
}

/**
 * Kind and number are what a card is; they change only before it first
 * starts. A numbered card keeps its ID in front of any new title.
 */
export async function updatedCardIdentity(
  existing: WorkboardCard,
  patch: WorkboardCardPatch,
  read: { boardKey: BoardKey; cards: () => Promise<readonly WorkboardCard[]> },
): Promise<CardIdentity> {
  const kind = normalizeCardKind(patch.kind, existing.kind);
  const renumber = patch.release !== undefined || patch.seq !== undefined;
  if ((kind !== existing.kind || renumber) && existing.startedAt) {
    throw new Error("a card's kind and number are fixed once it has started.");
  }
  const kept =
    existing.release !== undefined && existing.seq !== undefined
      ? { release: existing.release, seq: existing.seq }
      : undefined;
  if (patch.title === undefined && !renumber) {
    return { title: existing.title, kind, release: kept?.release, seq: kept?.seq };
  }
  const boardId = cardBoardId(existing);
  const number = renumber
    ? await boardCardNumber({
        cards: await read.cards(),
        boardId,
        boardKey: read.boardKey,
        kind,
        release: patch.release ?? existing.release,
        seq: patch.seq ?? existing.seq,
        cardId: existing.id,
      })
    : kept && { ...kept, key: await read.boardKey(boardId) };
  // Every field explicit: the patch spreads over the existing card, so an absent kind must clear it.
  return {
    ...identityOf(normalizeTitle(patch.title ?? existing.title), kind, number),
    kind,
    release: number?.release,
    seq: number?.seq,
  };
}
