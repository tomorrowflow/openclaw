import type {
  WorkboardCard,
  WorkboardNodeGrill,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { grillEndFromLog } from "./node-ticket-grill.js";
import { REPORT_FENCE } from "./node-ticket-report.js";
import { nodeTicketReviewComments, nodeTicketTarget } from "./node-ticket.js";

// Comments are capped at 8000 chars on write, so this bounds the brief's feedback section.
const REWORK_FEEDBACK_MAX_ENTRIES = 5;

/** The end of the grilling a resumed round carries out, with the grill session's result. */
function grillSection(grill: WorkboardNodeGrill, log: string | undefined): string[] {
  const pending = grill.pending;
  if (!pending || grill.status !== "closed") {
    return [];
  }
  const end = log === undefined ? undefined : grillEndFromLog(log, pending.at);
  return [
    "## Grilling ended",
    "The grilling you handed off ended. Its result is below and in the card's grilling log (`grilling.md`).",
    "",
    ...(!end
      ? ["The result could not be read from the grilling log."]
      : !end.result
        ? ["The grilling ended without a result; carry out the ticket with what you know."]
        : end.by === "ended by the operator"
          ? [
              "The operator ended the grilling, so the result is the grill session's last reply. It may be an open question rather than a decision; do not treat a question in it as settled. Carry out what it decides, and end with `needs_input` for a question that blocks the ticket.",
              "",
              "Result:",
              "",
              end.result,
            ]
          : ["Result:", "", end.result]),
    "",
    "Now carry out the ticket with that result and end with `done`, `blocked`, or `needs_input`. Do not start another grilling unless something new and blocking comes up.",
    "",
  ];
}

/** The message that starts or resumes a node ticket session: the round's input and the turn contract. */
export function buildNodeTicketMessage(params: {
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree;
  context: string;
  /** The grilling log while an end is pending; undefined when it is gone. */
  grillLog: string | undefined;
}): string {
  const round = params.worktree.feedback;
  const answering = round?.kind === "answer";
  // Kept until this round's report is imported, so a retried launch carries it too.
  const grill = round?.kind === "grill" ? params.worktree.grill : undefined;
  const rework = answering || round?.kind === "grill" ? undefined : params.worktree.rework;
  // The card still carries its published or questions record when the round
  // starts. A retried launch lost that record, so it reads the comments after
  // the carried cutoff, leaving out Workboard's own notices (no source).
  const handoffPhase = nodeTicketTarget(params.card)?.worktree?.handoff?.phase;
  const comments =
    handoffPhase === "published" || handoffPhase === "questions"
      ? nodeTicketReviewComments(params.card)
      : round
        ? (params.card.metadata?.comments ?? []).filter(
            (comment) => comment.createdAt > round.from && comment.source !== undefined,
          )
        : [];
  const feedback = rework || answering ? comments.slice(-REWORK_FEEDBACK_MAX_ENTRIES) : [];
  const reviewed = params.worktree.rung === "b";
  // The range the host import checks with `git diff --check` (node-ticket-handoff.ts). A
  // legacy rework without startCommit is checked from the host head, a subset of this range.
  const checkFrom = params.worktree.rework?.startCommit ?? params.worktree.baseCommit;
  return [
    `Work on this ticket: ${params.card.title}`,
    "",
    ...(grill ? grillSection(grill, params.grillLog) : []),
    ...(answering
      ? [
          "## Answers to your questions",
          `You stopped with open questions. Continue the ticket in the same worktree with the answers ${feedback.length > 0 ? "below" : "in the recent comments below"}.`,
          "",
          ...(feedback.length > 0
            ? [feedback.map((comment) => comment.body.trim()).join("\n\n---\n\n"), ""]
            : []),
        ]
      : []),
    ...(rework
      ? [
          `## Review rework, round ${rework.round}`,
          `This ticket already has a draft PR: ${rework.pullRequestUrl}. The worktree starts at the PR branch tip, including commits a reviewer pushed. Address the review feedback ${feedback.length > 0 ? "below" : "in the recent comments below"} with new commits on top; never rewrite or drop existing commits.`,
          "",
          ...(feedback.length > 0
            ? [
                "### Review feedback",
                "The Recent comments list further down shortens long comments; this is the full text.",
                "",
                feedback.map((comment) => comment.body.trim()).join("\n\n---\n\n"),
                "",
              ]
            : []),
        ]
      : []),
    "## Turn contract",
    `- Your working directory is the ticket worktree ${params.worktree.path} on branch ${params.worktree.branch}. Stay inside it.`,
    "- Commit your work on this branch. Never push, add remotes, or change other branches.",
    "- Change files with your Edit and Write tools, not with shell redirection, `sed -i`, or scripts that rewrite files: review findings are traced to the edit that wrote each line, and only tool edits are recorded. Commands that generate files, such as formatters, code generators, and lockfile updates, are fine.",
    `- Before a \`done\` report, leave the worktree clean (\`git status --porcelain\` prints nothing) and make \`git diff --check ${checkFrom}..HEAD\` pass: commit what belongs in the change, delete scratch files, and fix whitespace errors in a new commit. The import refuses either and blocks the card.`,
    "- Do not end the turn while a background job is still running; wait for it or stop it.",
    "- If something needs a decision you cannot make from the ticket and the repository, stop and ask; propose a default.",
    ...(reviewed
      ? [
          '- Before a `done` report, run a reviewer subagent over your changes against the repository\'s CODING_STANDARDS.md and have it return each finding as a repo-relative `path`, a 1-based `line`, the `rule` it breaks, and a one-line `body`. Address the findings and report every one in `review.items` with `fixed` true or false, plus a `note` on any you left. A review with no findings sends `"items":[]`. For a finding you left, `line` is its line number in the file at your final commit (HEAD): re-check it after the last commit. A `done` report without `review` blocks the card.',
        ]
      : []),
    "- End your final message with exactly one report block:",
    "",
    "```" + REPORT_FENCE,
    `{"outcome":"done|blocked|needs_input|grill","headline":"1-3 plain sentences for the operator","summary":"what changed and why","proof":[{"command":"…","status":"passed|failed|skipped","note":"…"}],${reviewed ? '"review":{"items":[{"path":"…","line":1,"rule":"…","body":"…","fixed":true}],"note":"…"},' : ""}"questions":["…"],"decisions":[{"ts":"…","phase":"…","decision":"…","why":"…","evidence":"…","result":"…"}]}`,
    "```",
    "",
    "Its text fields are Markdown. The `headline` of a `done` report replaces the card's summary on the board: say what changed and why in plain words. Use `done` only when the work is committed and its proof passed. Use `needs_input` for one or two open questions a comment can answer, each with your proposed default; the answers come back as the next turn of this session. Use `blocked` for anything else that stops you.",
    "Use `grill` when the ticket needs a back-and-forth with the operator to align on what to build (specification, scope, domain terms), and instead of `needs_input` when you have three or more questions or one question's answer changes another; any ticket may grill, not only a spec. Do not grill in this session: Workboard hands the grilling to a new session where the operator answers. Write the handoff for that session in `summary`, in readable Markdown: what you researched (facts, files, decisions already fixed), what is settled, the open frontier, and the first question with your recommended answer. When the grilling ends, this session resumes with its result.",
    'The `summary` of a `done` report is posted as a card comment, so write it as sections the operator can scan: `**What:**` then a `- ` list of the changes, `**Why:**` in a sentence or two, and `**Notes:**` only for follow-ups or anything left open. The proof is recorded from `proof`; don\'t repeat it. Each question is one line, `**Q<n> – <title>:** <question> ➡️ <your proposed default>`, worded so "yes" accepts the default. Use inline code for paths, commands, and identifiers; no headings.',
    "`decisions` is your decision trail for this turn, so the operator sees what you decided without reading the session: one row per decision point or checkpoint (a fork you chose, a unit you verified, a pivot or revert, a blocker), at most 30, not one per step. Each cell is one short line of plain words, not Markdown; `ts` is the time, `phase` a word like plan, build, verify, or fix; `evidence` is a pointer (a commit SHA, `file:line`, or a command), never a paragraph.",
    "Proof entries describe the final state. Any `failed` entry blocks a `done` report, so a test you ran red before the fix goes in the note of its passing entry, not in an entry of its own.",
    "",
    params.context,
  ].join("\n");
}
