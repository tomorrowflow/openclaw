/**
 * What the Control UI's board info popover lists. Operator-set only, and
 * absent from every brief.
 */
export type WorkboardBoardInfo = {
  /** Project links (a test deployment, a repository): navigation for the operator. */
  links?: WorkboardBoardLink[];
  /**
   * Secrets-store entries the operator may reveal from the popover. The board
   * holds names, never values. Changing the list needs operator.admin.
   */
  secrets?: WorkboardBoardSecret[];
};

/** One link in a board's info popover; entries sharing a `group` render under one heading. */
export type WorkboardBoardLink = { label: string; url: string; group?: string };

/** One revealable secret in a board's info popover: `name` is the secrets-store entry name. */
export type WorkboardBoardSecret = { label: string; name: string; group?: string };
