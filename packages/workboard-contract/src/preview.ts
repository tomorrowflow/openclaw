/**
 * A board's review preview: argv run on the node in a detached worktree of the
 * imported head, `{port}` and `{card}` (the card id's first 8 characters)
 * substituted in every element. `up` starts the stack on 127.0.0.1:{port},
 * `down` stops it; `ports` is the range previews take ports from. `env` maps
 * variable names to SecretRefs the Gateway resolves at each start and passes
 * to `up` only; the board keeps the refs, never the values.
 */
export type WorkboardPreviewSettings = {
  up: string[];
  down: string[];
  ports: { from: number; to: number };
  env?: Record<string, WorkboardPreviewSecretRef>;
};

/** A store SecretRef (`openclaw/plugin-sdk/secret-ref-runtime`); other sources are refused. */
export type WorkboardPreviewSecretRef = {
  source: "store";
  provider: string;
  id: string;
};

/**
 * A card's running review preview. `down` is the board's `down` as it was at
 * start, substituted, so a board edit cannot strand a running stack. A failed
 * record stays until the card leaves review, its head changes, or the
 * operator retries (`workboard.cards.preview.retry`); `port` is absent only
 * when the node had none free.
 */
export type WorkboardNodePreview = {
  headCommit: string;
  nodeId: string;
  path: string;
  down: string[];
  at: number;
} & (
  | { state: "starting"; port: number }
  | { state: "up"; port: number; url: string }
  | { state: "failed"; port?: number; error: string }
);
