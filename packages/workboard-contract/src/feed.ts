/**
 * The board's chat feed: each active card gets a thread under the `to`
 * channel of `channel` (a channel plugin id such as `discord`), where
 * Workboard posts the card's steps under the acting agent's name. Replies
 * there from `operatorId` (the operator's chat user id) become operator
 * comments, and blocked or needs:user cards mention that user. With
 * `agentId`, that agent answers each operator reply in the thread: Workboard
 * runs it in one session per card, and its answer is its comment on the card.
 * A projection only: a post that fails is counted in `workboard.health`,
 * never replayed.
 */
export type WorkboardBoardFeed = {
  channel: string;
  to: string;
  accountId?: string;
  operatorId?: string;
  agentId?: string;
};

/**
 * Board feed posts since the Gateway started. A failure is a post given up
 * after its retry, or a card thread that could not be bound or unbound.
 */
export type WorkboardHealthFeed = {
  posts: number;
  failures: number;
  lastPostAt?: number;
  lastFailureAt?: number;
  lastError?: string;
};
