---
summary: "Optional Workboard boards for agent-owned cards and rule-based session views"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
  - You want sessions grouped by session status, observer health, and pull-request state
title: "Workboard plugin"
doc-schema-version: 1
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui): agent-sized work cards, assignment to agents,
and a link back to the card's task, run, and Control UI session. A separate
**Sessions board** groups existing sessions into editable columns using rules over
Gateway-owned facts.

Workboard is intentionally small: it tracks local operating work for one
OpenClaw Gateway. It is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Enable it

Workboard is bundled but disabled by default:

1. Open **Plugins** in the Control UI, or use `/plugins` relative to the
   configured Control UI base path. For example, a base path of `/openclaw`
   uses `/openclaw/plugins`.
2. Open the **Workboard** plugin, select **Lifecycle**, and turn on the enabled
   switch. Because Workboard is included with OpenClaw, it does not need an
   **Install** action.
3. Wait for the lifecycle action to finish, then open the Workboard tab.

The Workboard tab appears in the Control UI nav after the plugin runtime loads.
While it is disabled, the tab stays hidden from navigation. Opening the
`/workboard` route directly while the plugin is disabled or blocked by
`plugins.allow`/`plugins.deny` shows a plugin-unavailable state instead of card
data.

The equivalent CLI workflow is:

```bash
openclaw plugins enable workboard
openclaw dashboard
```

Enablement applies to a running Gateway automatically. If it is offline, start
it before opening the dashboard. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Configuration

Enable/disable Workboard with the standard plugin entry. Its plugin-specific
config covers [node tickets](#node-tickets) (how many may run at once, and the
GitHub token map for their draft PRs) and an optional transcript viewer:

```json5
{
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {
          // Node tickets running at once across all nodes (default 2).
          nodeTickets: { maxConcurrent: 2 },
          // Optional transcript viewer listening on this loopback port of the Gateway host.
          transcriptViewer: { port: 17317 },
          // Optional office viewer (Habblaud) on this loopback port of the Gateway host.
          officeViewer: { port: 17320 },
          // Optional architecture viewer (SeeCode) on this loopback port of the Gateway host.
          architectureViewer: { port: 17318 },
          github: {
            repos: {
              // Keyed by the owner/name of the host clone's origin.
              "acme/app": {
                token: { source: "store", provider: "default", id: "GH_TOKEN_ACME_APP" },
              },
            },
          },
        },
      },
    },
  },
}
```

Each token is a [SecretRef](/gateway/secrets) to a fine-grained token with
contents and pull request write access to that one repository. Run
`openclaw secrets reload` after changing a referenced value.

`transcriptViewer.port` is the loopback port of a transcript viewer that runs
on the Gateway host. It must be an integer from 1 to 65535. Any other value fails
Workboard's config validation at
`plugins.entries.workboard.config.transcriptViewer.port`, so the Gateway
[refuses to start](/gateway/configuration#strict-validation) and a hot reload
with that value is skipped. When it is set, the Control UI adds a
**Transcripts** page under Workboard. Card details also show an **Open
transcript** button under the Session row of a card with a linked session. Each
click opens an [OpenClaw Portal](/gateway/portals) to the port and shows the
viewer in a new tab: the Transcripts page opens the viewer's `/`, and a card
opens its `/card/<cardId>`. Opening a portal needs the `operator.write` scope, so
operators without it see neither the Transcripts page nor the card button. The portal proxy rewrites
`Host` to `localhost:<port>`, so the viewer must accept that host. Portals close
when the Gateway restarts; the next click opens a new one.

`officeViewer.port` is the loopback port of an office viewer, such as
[Habblaud](https://github.com/tomorrowflow/habblaud), a pixel-art live office of
your agents. It follows the same rules as `transcriptViewer.port`: an integer
from 1 to 65535, validated at
`plugins.entries.workboard.config.officeViewer.port`. When it is set, the
Control UI adds an **Office** page under Workboard that embeds the viewer in a
frame through an [OpenClaw Portal](/gateway/portals), with an **Open in new tab**
button. Opening a portal needs the `operator.write` scope, so operators without
it do not see the page.

To run Habblaud as the office viewer:

1. On the Gateway host, start Habblaud on loopback in read-only portal mode with
   `HABBLAUD_PORTAL=1`, `HABBLAUD_WORKBOARD_URL=ws://127.0.0.1:<gateway port>`,
   and `HABBLAUD_WORKBOARD_TOKEN` set to a Gateway token.
2. Approve its device pairing once with `openclaw devices approve <requestId>`.
3. Set `officeViewer.port` to the port Habblaud listens on.

`architectureViewer.port` is the loopback port of an architecture viewer, such
as the SeeCode viewer (`viewer/` in
[tomorrowflow/SeeCode](https://github.com/tomorrowflow/SeeCode)), which renders
each project's `docs/architecture` maps keyed by board id. It follows the same
rules, validated at `plugins.entries.workboard.config.architectureViewer.port`.
When it is set, the header of each board with a [node target](#node-tickets)
(`orchestration.defaultTarget`) shows an **Architecture** button that opens the
viewer's `/board/<boardId>/` in a new tab through a portal. Boards without a node
target have no repository and show no button, and there is no Workboard page for
this viewer. The button needs `operator.write`, and the viewer must accept
`Host: localhost:<port>`.

```bash
openclaw plugins disable workboard
```

## Storage recovery

If a SQLite worker fails, Workboard reopens its store through the database worker
owner on the next call, after native cleanup finishes. An operation already in
flight can still report a failure or an unknown write outcome; Workboard does not
replay that operation. A Gateway restart is not needed once the underlying storage
problem is resolved. Updates require no configuration or data migration.

## Board appearance

While Workboard is open, its sidebar entry expands to show both Cards and
Sessions boards, with the open board highlighted. Select a nested board to open it.
Sidebar labels use the board name; boards with the same name include their kind
in parentheses, such as **Planning (cards)** and **Planning (sessions)**.
Boards you create in the Control UI are pinned in the sidebar immediately.
Right-click a board, or focus its link and press **Shift+F10** or the context-menu
key, to **Pin to sidebar**, **Unpin from sidebar**, or **Delete board…**.
Deleting asks for confirmation naming the board and requires write access.
The default board and boards that still contain cards cannot be deleted.
Deleting the open board returns to the Workboard root page. You can also use
**Customize** to manage pins; removed pins stay removed.
Pinned boards remain available as top-level entries when you leave Workboard,
and you can drag them to reorder them.

Choose **New board**, then **Cards** (the default) or **Sessions**. A Sessions
board starts with the columns described below. A board's kind is permanent;
create another board to use the other kind. Existing boards remain Cards boards.

Use **Edit board** to change a board's name, icon, and color. **Reset to default**
clears the icon and color when you save; canceling leaves the saved board unchanged.
For Sessions boards, the same dialog also edits column labels, colors,
descriptions, column order, and the fallback column. Ask the Board agent to edit
column rules. Saving only the name, icon, or color leaves the saved columns unchanged,
including column edits made by another operator while the dialog was open.

For `workboard.boards.upsert`, omitting `icon` or `color`, passing `null`, or passing
an empty string preserves the existing value, including for older clients. To clear
appearance explicitly, send `clearAppearance: ["icon", "color"]`, or list only the
field you want to clear. Listed fields are cleared even if the request also supplies
a replacement value for them. Other fields retain their ordinary update behavior.
`clearAppearance` must be an array containing only `"icon"` and `"color"`; an empty
array changes nothing. Clients using this argument need a Gateway version that
supports explicit appearance clearing; older Gateways do not implement this reset.

Full card lists share one prepared, claim-token-redacted snapshot per board scope
and card revision. `workboard.cards.list` returns `revision`; repeat the same query
with `{ sinceRevision: revision }` for `{ unchanged: true, revision }` when current.
The revision includes the store epoch and, for scoped queries, the normalized
`boardId` and requested `sessionKey`. The optional `sessionKey` filter takes a
nonempty canonical session key and selects cards linked directly, through their
execution, or through a recorded attempt or event. It can be combined with
`boardId`; omitting it keeps the full-list behavior. Selection happens in the
database before card notes, comments, events, and other details are loaded.
Ordinary keys and Matrix/Signal structural segments compare without case;
opaque peer IDs and catalog source identifiers retain their exact identity. The
Control UI and server filter share `normalizeSessionKeyForComparison` from
`@openclaw/normalization-core`, exposed to the plugin through
`openclaw/plugin-sdk/session-key-runtime`. Candidate matching reads only session-link
fields before loading matching cards. Reconnects request a fresh snapshot of the
same scope. `plugin.workboard.changed` includes
an event `revision` and a separate `cardsRevision`: session-fact notifications
advance the event sequence without invalidating unchanged cards.

## Sessions board

Use a Sessions board to see where your conversations stand without creating
cards. By default, it includes sessions from all configured agents with activity
in the last 72 hours and excludes archived sessions, automation (cron) sessions,
system sessions, dock conversations, and each agent's home session. Subagent sessions remain included.
Set `scope.includeAutomation: true` to include automation and system sessions, or
`scope.includeHome: true` to include home sessions. The Board agent can set these
options. Existing boards use the same defaults without a migration. Each session appears in
exactly one column. Open a tile to continue its conversation; the tile also shows
its agent, run state, observer headline when available, pull requests, and recent
activity. Message previews are plain text: Markdown formatting and HTML are removed,
link labels are retained, and whitespace is collapsed before the 400-character limit.
Tiles link up to four pull requests, ordered by open, draft, merged,
then closed state, with a count for any additional pull requests. The agent filter
narrows the displayed sessions without changing the
saved board scope.

Dock conversations stay excluded even when automation is included.

**People filter:** Choose **Everyone** (the default), **Involving me**, or a person
beside the agent filter. Involving me shows sessions you own or previously prompted;
a person selects their profile associations. The choice is remembered per viewer,
device, Gateway, and board. It does not change the shared board, rules, or
the Board agent. API clients can pass `view: { involvingMe?: boolean,
involvingProfileId?: string, includePeople?: boolean }` to
`workboard.sessionsBoard.read`; `includePeople` returns the people facet for the picker.

Columns are rules over Gateway-owned run state, observer health, and
pull-request state. Run state comes from the live run registry and queued inputs;
a saved `running` status without an active run is idle. Health comes from the Gateway session observer: live digests
for sessions someone is watching in the Control UI, and a terminal digest when an
observed run ends. Sessions nobody watches have no health, so they match only run
and pull-request rules. Reads follow the current caller's session visibility; board specs and
pins follow the Gateway's trusted-operator model. Interactive edits are admitted
under the caller's live authority immediately before the write. Draft and
incognito sessions never enter a Sessions board or its facts reads.

New Sessions boards use these columns, in this order:

| Column      | Rule                                                              |
| ----------- | ----------------------------------------------------------------- |
| Needs input | Observer health is `waiting-on-user`.                             |
| Stuck       | Observer health is `stuck` or `failed`, or run state is `failed`. |
| Working     | Run is active.                                                    |
| In review   | A pull request is open or draft.                                  |
| Merged      | A pull request is merged.                                         |
| Done        | Observer health is `done`. This is also the fallback column.      |

Placement uses an operator pin when its column still exists, then the first
matching column in saved order, then the fallback column. `match` accepts one
rule or an any-of array such as Stuck's
`[{health:["stuck","failed"]},{run:["failed"]}]`, with every field within a rule
required to match. Values within a field are alternatives. Column names
and descriptions help people understand the board; `match` rules decide placement.

Drag a session into another column, or ask the Board agent to move it, to pin
its placement. Pins remain in effect when session facts change. If a pinned
column is removed, the board applies its rules again. Tile tooltips distinguish
**by rule** and **pinned**.

Facts update live from session changes, with automatic board rereads at most once
every five seconds. Category-only session updates and card-only changes do not
reload Sessions boards. The Gateway selects the authorized roster once and reuses
immutable facts for unchanged sessions. The board keeps one frozen snapshot per
board and people view, replacing only rows whose facts changed. Live run state,
background previews, and time-dependent subagent state remain current; profile,
configuration, topology, and access changes refresh authorization. Age-window and
unavailable-PR retry deadlines still refresh the snapshot. Tool callers obtain
their own caller-scoped roster; sharing never expands session visibility.
`workboard.sessionsBoard.read` returns a `revision`; repeat the same query with
`{ sinceRevision: revision }` for `{ unchanged: true, revision }` when current.
Reconnects and view changes request a full snapshot. The Workboard change event's
`sessionsRevision` advances for board edits, operator pins, and session fact
invalidations independently of `cardsRevision`.

Pull-request facts come from the Gateway's shared PR owner, independently of
which sessions appear in a Control UI sidebar. Reads use prepared Gateway facts
without waiting for Git or pull-request requests. Missing snapshots load through
that owner's bounded background loader and announce a board change when ready.
If PR facts become unavailable or GitHub rate limits requests, the Gateway's
selected-facts owner retains the last ready PR list for board cards and column
rules while updating run state and health. Unavailable PR reads retry per session, starting after one minute
and doubling to a 15-minute maximum; a successful read resets the delay.
Redaction changes omit retained PR titles until fresh source text is available,
without changing known PR states or their retry schedule.
An inline warning distinguishes stale PR facts from facts not loaded yet and
identifies GitHub rate limiting. A failed facts read keeps the last known facts
and placement; sessions with no known facts use the fallback column with reason
`facts-unavailable`. A session whose available facts match no rule also uses that
reason while its pull-request facts are unknown. Opening a board starts any needed
background refresh. Shared snapshots reuse prepared facts until a publication,
redaction change, board age-window expiry, or a pull-request retry becomes due; failure fallback
retains the last known facts. If redaction rules change during a facts outage,
the board discards retained text while keeping known run, health, and PR states.

When the Control UI host supports a session dock, **Board agent** opens a
conversation beside the board. Its first use creates and saves a dedicated
conversation named **Sessions board · &lt;board name&gt;**. This is a dock conversation:
it stays out of session lists, Involving me views, and people counts. Open it from
the **Board agent** button. Its human creator, sharing, and sandbox rules are the
same as an ordinary conversation.

For boards with an older Board agent conversation, the next **Board agent** use
creates a new dock conversation and saves its reference. The old conversation
keeps its history and remains an ordinary session that you can archive; its
creation surface and provenance are not rewritten.

The Board agent is the only model used by the board, invoked on demand to change
columns, rules, scope, or pins using these tools:

| Tool                              | Arguments and behavior                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `workboard_sessions_board_read`   | Optional `boardId`; returns board, columns, sessions, and any warning.                                                        |
| `workboard_sessions_board_update` | Optional `boardId`, plus `columns` or `scope`. `columns` replaces the complete ordered list; retain ids when renaming labels. |
| `workboard_sessions_board_move`   | Optional `boardId`, required `sessionKey` and `columnId`; pins that session's placement.                                      |

These three tools are available to every agent once the plugin is enabled; unlike
the card tools they need no `tools.allow` entry, so the Board agent works out of
the box. Omit `boardId` only when exactly one Sessions board exists. The dock attaches page
context to the conversation, but plugin tools do not receive that context as a
structured argument. With several Sessions boards, the agent must pass the board
id from that context or from `workboard_boards`.

Specs allow 2–12 columns with unique lowercase slug ids (1–48 characters), labels
(1–60), and descriptions (1–400). Exactly one column must have `fallback: true`.
Optional colors use the board palette. `scope` accepts `agentIds`,
`includeArchived`, `includeAutomation`, `includeHome`, and a positive `maxAgeHours`.
The include options default to false. Rules can match `health`, `run`
(`active`, `idle`, `failed`), `pullRequest` (`none`, `open`, `draft`, `merged`,
`closed`), and `archived`. Unknown pull-request state does not count as `none`.

The Gateway methods are `workboard.sessionsBoard.read` (`operator.read`) and
`workboard.sessionsBoard.update` and `.move` (`operator.write`). All require
`boardId`. Update takes a `patch` object with the spec fields, including the
dock's `agentSessionKey`; move additionally requires `sessionKey` and `columnId`.
Create with `workboard.boards.upsert` and `kind: "sessions"`, or with
`workboard_board_create`. Changing an existing board's kind is rejected.

Workboard stores board specs and operator pins in SQLite. Session status,
observer digests, and pull-request state remain owned by the Gateway. On plugin
startup, older automatic placements are removed; operator pins are preserved.
Boards whose rules still match the previous defaults receive the new run-based
rules; only the old default column order is reordered. Customized rules, labels,
descriptions, and custom column order are preserved.
Sessions boards never hold cards: card creation, capture, and dispatch reject a
Sessions board destination. Deleting one removes its pins without deleting any
sessions or its Board agent conversation.

## Card fields

| Field       | Values                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                     |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                             |
| `labels`    | free-form strings                                                                                             |
| `agentId`   | optional assigned agent                                                                                       |
| linked refs | optional task, run, session, or source URL                                                                    |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status) |

Card text is Markdown: notes, comments, block reasons, and summaries render as
sanitized Markdown in the Control UI, and the agent tools that write them say
so.

Each card can carry an operator summary in `metadata.automation.summary`: one
to three plain sentences that say what the card is and why. The agent that
drafts a card sets it with `summary` on `workboard_create` (Gateway clients pass
`summary` to `workboard.cards.create` or `workboard.cards.update`).
`workboard_specify`, `workboard_complete`, and `workboard_decompose` replace it
with their own summary, and a node ticket's `done` report replaces it with its
`headline` (see [node tickets](#node-tickets)). The board card shows the
summary under the title, clamped to three lines, in place of the notes preview.

<a id="card-stage" />

Gateway operator reads (`workboard.cards.list`, card results of card methods,
the CLI) add a derived, read-only `stage` beside each card's metadata. It is
never stored. The Control UI shows it as one status line under the summary on
the card and in the card's overview tab, with the time since the card entered
that stage:

| `stage.kind`        | When                                                                                       | Fields                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `queued`            | A [queued start](#queued-starts) waits for its parents, their PRs, or a node slot.         | `since`                                                      |
| `running`           | The card is `running`.                                                                     | `since`, `nodeId`, `reworkRound`, `attempt`                  |
| `questions`         | A node ticket waits with open questions; `escalatedAt` once passed to you.                 | `since`, `escalatedAt`                                       |
| `grilling`          | A node ticket grills you in its grill session; `round` counts handoffs.                    | `since`, `round`                                             |
| `verifying`         | An imported round waits for the board's verifier.                                          | `since`                                                      |
| `reviewing`         | An imported round waits for the board automation's verdict.                                | `since`                                                      |
| `awaiting_review`   | An imported round has both and waits for the operator's decision.                          | `since`                                                      |
| `review_incomplete` | An imported round still lacks either after 30 minutes; you may decide it.                  | `since`, `missing`                                           |
| `published`         | A node ticket's PR is published; `pullRequestState` is its [GitHub state](#pr-state-sync). | `since`, `pullRequestUrl`, `reworkRound`, `pullRequestState` |
| `blocked`           | The card is `blocked`.                                                                     | `since`                                                      |
| `review`            | Any other card in `review`.                                                                | `since`                                                      |
| `done`              | Any other card in `done`.                                                                  | `since`                                                      |

The status line of a published ticket reads **PR open**, **Draft PR**,
**PR merged**, or **PR closed** from `pullRequestState`; an open or draft PR
after a rework round names the round.

Idle statuses (`triage`, `backlog`, `todo`, `scheduled`, `ready`) and archived
cards have no stage. `since` comes from recorded facts: the start request, the
handoff timestamps, the running attempt, or the newest card event that entered
the status. A status entered before the newest 50 events has no `since`. An
imported round's `since` is the import while it verifies, the verification's
end while the verdict is outstanding, and the later of the two once it awaits
your decision, so your wait starts at zero. The stage reads comments only for
when a verdict arrived, never what it says, so an agent's pending verdict stays
hidden.

Operator reads of a node ticket also add a derived `reviewTimes`, oldest round
first: each round's `importedAt`, its verification's `startedAt` and `endedAt`,
and its `verdictAt`. The Control UI lists them in the card's **Activity** tab as
how long the verification took and how long after it the verdict arrived. They
carry times only, so blind review hides nothing they show. A publish records
both in the round's `reviews` entry (`verdictAt`, `verification.startedAt`,
`verification.endedAt`); rounds published before that show no verification
time.

Cards also carry compact metadata:

| Metadata      | Values                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| card state    | attempts, comments, links, proof, artifacts, automation settings, attachments, worker logs, worker protocol state, claims, diagnostics, notifications, template id, archive state, stale-session detection                                                                                                                                                   |
| recent events | `created`, `edited`, `moved`, `linked`, `specified`, `decomposed`, `claimed`, `heartbeat`, `execution_updated`, `attempt_started`, `attempt_updated`, `comment_added`, `link_added`, `proof_added`, `artifact_added`, `attachment_added`, `diagnostic`, `notification`, `dispatch`, `orchestration`, `protocol_violation`, `archived`, `unarchived`, `stale` |

This metadata lets an operator see how a card moved through the board without
opening the linked session. It is local operating context, not a replacement for session
transcripts or GitHub issue history.

The plugin and Control UI use one Workboard card contract. Control UI refreshes
therefore preserve workspace provenance and authority, claim state, diagnostic
actions, and notification sequence numbers instead of projecting a smaller
UI-only copy of the card. Unknown diagnostic kinds, diagnostic severities, and
notification kinds are ignored until both surfaces support them. They are never
rewritten into another valid state.

The open Workboard tab updates from `plugin.workboard.changed` invalidations. Each
event contains only a store epoch and revision. The UI then rereads stored
cards through the normal `operator.read` RPC. Multiple revisions coalesce into
one follow-up read. Workboard defers that read while a card is being dragged,
edited, or written, then resumes after the local interaction finishes. A
reconnect always performs a reload from the store. There is no routine full-card
poll, and **Refresh** remains available as manual recovery.

The sidebar catalog reads names and summaries from `workboard.boards.list`.
The session-header chip reads only cards linked to its session through the
`workboard.cards.list` session filter; neither downloads unrelated card history.
These narrower reads preserve the existing rendering.

The Gateway shares one immutable full `workboard.cards.list` payload per board
filter at each store revision, including concurrent reads. Session-filtered reads
do not retain a payload cache. Card and board writes invalidate cached payloads
before the next read; the existing change service also
invalidates it when it observes a commit from another SQLite connection.
Each response still includes all board summaries, so a change to another board
invalidates the payload too. Claim tokens remain redacted, and the RPC response
shape is unchanged.

When more than one board exists, the toolbar includes a **Board** filter backed
by persisted board metadata rather than only the currently visible cards. Empty
and archived boards therefore remain selectable. Cards without an explicit
board id belong to the primary `default` board. Each board has a primary
`/workboard/<boardId>` page that can be bookmarked, shared, or pinned in the
sidebar. The previously shipped `/workboard?board=<boardId>` form remains a
compatibility alias and redirects to that page while preserving other query
parameters. Choosing **All boards** returns to `/workboard`.

A board can store an `automationJobId` reference to the automation job that
owns its AI-categorization prompt, model, schedule, and run history. The board
page shows an **Automation** link when that reference is present. Matching
session events nudge the attached automation through the active Workboard service's
scheduler authority, including after the worker's tool authority closes, with events
for the same board coalesced for 60 seconds; events during that window run the
automation once more when it ends. If an attempt ends while its run is still
active, the lifecycle sweep nudges the automation when it records the terminal
outcome. The automation's schedule remains the backstop. Disabled and
auto-disabled automations are never nudged. Deleting
the board does not delete or otherwise mutate the
operator-owned automation job.

Cards are stored in the plugin's own Gateway state and move with the rest of
that Gateway's OpenClaw state (see [Storage](#storage)).

## Starting work from a card

Unlinked cards without an active or unresolved task association can start work directly:

- **Run Claude** / **Run OpenAI** starts a task-tracked agent run with an
  explicit engine, sends the card prompt, and marks the card `running`. Claude
  runs use `anthropic/claude-sonnet-4-6`. OpenAI runs use `openai/gpt-6-astra`.
- **Open Claude** / **Open OpenAI** creates a linked Control UI session without
  sending the card prompt, for manual work that stays attached to the board.
  Opening it clears any schedule and moves a `scheduled` card to `todo`.
  Other cards keep their status.

**Start**, **Run Claude**, and **Run OpenAI** keep you on the board; only
**Open Claude** and **Open OpenAI** open the new session.
Autonomous starts use the Gateway's task-tracked agent run path (default agent
and model unless Claude/OpenAI is chosen explicitly). Workboard then links the
resulting run id and session key back onto the card. Each linked
execution also records an attempt summary (engine, mode, model, run id,
timestamps, status, rolling failure count) so repeated failures stay visible.

The Control UI reads lifecycle from the card's linked session. Card status changes are persisted by the Gateway-side Workboard
plugin using the linked run and session lifecycle (see
[Session lifecycle sync](#session-lifecycle-sync)).

## Agent tools

The card tools below are optional plugin tools. Enabling Workboard exposes only
the three Sessions board tools to agents; an agent that should create, claim, or
complete cards needs the card tools allowed for it. Add the plugin id to the
agent's tool policy to allow every Workboard tool, or list individual tool names
or a pattern such as `workboard_*`:

```json5
{
  agents: {
    entries: {
      main: {
        tools: { alsoAllow: ["workboard"] },
      },
    },
  },
}
```

Without that entry the agent sees only `workboard_sessions_board_*` and cannot
manage cards. Workers that Workboard starts from a card (**Start** or dispatch)
do not need it: each worker run is granted `workboard_heartbeat`,
`workboard_complete`, and `workboard_block` for its card.

| Tool                                                                                                                                             | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                    |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context from the same card read (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).       |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, touches, board, workspace metadata, idempotency key, runtime limit, retry budget, operator summary.                                  |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. Queued children stay `todo` until every parent is `done`, then move to `ready`; backlog children wait until started.                                       |
| `workboard_reference`                                                                                                                            | Reference another card with a `relates_to` link (no dependency), so the card's Prototype and Screenshots tabs also show its committed files                                               |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                        |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                          |
| `workboard_release`                                                                                                                              | Release the claim after completion, pause, or handoff; can move the card to a next status.                                                                                                |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                 |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                         |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                           |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                            |
| `workboard_sessions_board_read` / `workboard_sessions_board_update` / `workboard_sessions_board_move`                                            | Read Sessions board placements, edit columns, rules, or scope, or pin a session in a column.                                                                                              |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                      |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                      |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                             |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events. |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces and queue stats.                                                                                                                                                 |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work.                                                                                                                                                           |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                    |
| `workboard_escalate`                                                                                                                             | Record that a node ticket's open questions went to the operator (`handoff.escalatedAt`), so automation reviews the round once                                                             |
| `workboard_unblock`                                                                                                                              | Move blocked work back to `todo`.                                                                                                                                                         |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope.                                                                                                      |
| `workboard_grill_done`                                                                                                                           | Hand a node ticket grilling's result back from its grill session; only that session may.                                                                                                  |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                        |

Creating linked cards, linking existing cards, and decomposition save one card at a
time. If a later step fails, completed steps remain visible; Workboard reports the
original error without rolling them back. Inspect the board before retrying, and
repair missing links or remove unwanted partial cards as needed.

Proof statuses are worker-reported outcomes, not independent verification. A `passed`
entry means the worker reports that its command or check succeeded. Consumers that need
an independent quality gate should inspect the attached command, URL, or artifact and
run their own verifier. `workboard_proof` returns the new record's `proofId`. When
`workboard_complete` reports that same proof's terminal status, pass `proofId` so the
pending record is resolved in place without losing its identity or timestamp. A proof that
already has the same terminal status is reused unchanged. Completion proof without
`proofId` remains append-only, so a later retry cannot rewrite older history merely because
its command or note is identical.

Completion validates its proof, artifacts, and notification before saving the card.
A validation failure leaves the card unchanged. Completion notifications preserve
the full execution run ID, including IDs longer than 120 characters. Run IDs are limited
to 512 characters across execution admission, launch metadata, worker logs, and
notification subscriptions. Use a shorter ID if admission rejects it; IDs are never
truncated. Metadata trimming preserves the completion's new notification and proof,
discarding older history as needed. If those records cannot fit, completion fails
without saving the card.

Claimed cards reject agent-tool mutations from other agents unless the caller
holds the claim token returned by `workboard_claim`. Every card returned by an
agent tool or Gateway RPC call redacts `metadata.claim.token` to `[redacted]`
(the token itself is returned once, top-level, only from `workboard_claim`),
so Control UI operators and other agents can inspect claim state without ever
seeing a usable token. Recovery goes through
`workboard_promote`/`workboard_reassign`/`workboard_reclaim`, which do not
require the token.

Promotion only moves `todo` cards to `ready`; every other status returns an
error without changing the card, including when `force` is set. To recover
blocked work, use `workboard_unblock` first to move it to `todo`.
`force` only bypasses dependency or schedule holds.

## Dispatch

Dispatch is Gateway-local: it does not spawn arbitrary OS processes. Normal
OpenClaw subagent sessions still own execution. One dispatch pass:

1. Promotes dependency-ready cards.
2. Blocks expired claims or timed-out runs.
3. Marks board-configured triage cards as orchestration candidates.
4. Claims a small batch of ready cards and starts worker runs through the
   Gateway subagent runtime.

Idle scans leave ready-card history unchanged. Existing dispatch counters and
timestamps remain as historical values; new launches use the card's launch,
attempt, and execution history.

Workers get bounded card context plus the claim token needed to heartbeat,
complete, or block the card through the Workboard tools.

Workspace paths follow the caller's existing filesystem authority:

- Gateway clients with `operator.write` can use configured agent workspaces.
- `operator.admin` clients can use other host checkouts.
- Sandboxed agent tools use their sandbox workspace access.
- Unsandboxed workspace-only tools use their configured workspace root.

Workboard records that authority when a workspace is
assigned and intersects it with the current caller's authority again at dispatch,
so a persisted card cannot widen a later caller's access. Older cards with an
explicit host workspace but no recorded authority must have that workspace
re-saved before a full-host dispatch. Cards without a host path adopt the
current caller's authority when first dispatched.

Workspace-bound dispatch accepts a directory or Git checkout only when its
repository root exactly matches the target agent workspace. A worktree request
is narrowed to that directory and persisted as a directory workspace, so the
host does not materialize the checkout or execute repository setup code. The
target worker must use a writable, non-shared Docker sandbox for that exact
workspace, without elevated execution, persisted host/node exec overrides, or
unclassified plugin and MCP tools. Workboard enumerates its registered tools
instead of trusting a `workboard_*` prefix, and dispatch refuses a hot Docker
container whose live mount/config hash is stale. Dispatch reports the
incompatible target policy instead of starting a less-confined worker.
Full-host dispatch may target other local checkouts and keeps normal managed-
worktree setup.

Workspace authority does not create a second card-lifecycle permission model.
Callers that may mutate Workboard cards can manually move them through the same
statuses on every surface. Read-only workspace access only prevents worker
dispatch that needs writes.

### Node tickets

A card whose `metadata.automation.target` has `kind: "node-claude"` runs as a
fresh Claude Code session on a paired node instead of a Gateway subagent. The
target names the node (`nodeId`), the node's clone (`repoPath`), where ticket
worktrees go on the node (`worktreesRoot`), the Gateway host's clone
(`hostRepoPath`), and optionally `baseRef`, `model`, and `screenshotDirs`.
Only full-host dispatch starts node tickets, and only operator clients set
targets.

`screenshotDirs` lists worktree-relative directories the agent writes
screenshots into (default `["docs/screenshots"]`; at most 8, no `..` or
absolute paths). A node ticket's session header shows a **Screens** button
that opens a session panel with the images under those directories in the
node worktree right now that the running round added or changed (two levels
deep, newest first; files the base branch already had are left out, using
`git diff` and `git ls-files` through `system.run`) and each round's committed
images. The panel lists again every 20 seconds while it is open and
the card is running, skipping a tick while the previous list is still loading;
a node walk that takes over 30 seconds shows as unavailable. The card drawer's
**Screenshots** tab shows only committed rounds and never walks the node. Once
the imported round's verification finished, the tab also carries the
operator's **Looks right** / **Problem** control for the round's
[visual check](#node-tickets) (`workboard.cards.visualCheck`). Live
listing uses File Transfer's `dir.list`, `file.fetch`, and the node's
`system.run`, so it needs the grants in
[Workboard node setup](/plugins/workboard-node-setup#gateway-side); without
them the panel names the denial and still shows the committed rounds.

A node ticket's throwaway prototypes are self-contained HTML files the agent
writes under `docs/prototypes/` (for example `docs/prototypes/<ID>/flow.html`).
The card drawer's **Prototype** tab lists the `.html` and `.htm` files under
that directory in the node worktree that the running round added or changed
(newest first, same walk and grants as live screenshots) and those each round
committed there, and appears once at least one exists. A picker switches between files, and the chosen one
renders through the Control UI's HTML preview, the same one chat uses for HTML
files: the prototype runs on the Gateway's isolated sandbox origin, so its
scripts work but it cannot reach the Control UI, and the operator's
[`gateway.controlUi.embedSandbox`](/web/control-ui/chat#hosted-embeds) setting
applies (`strict` turns scripts off).
**Open in new window** opens the chosen prototype as its own Control UI page,
inside the usual Control UI navigation. The page reads the file again from its
link, so the link also works on another device signed in to the same Control
UI. The tab lists when the drawer opens, when the card imports a round, and on
**List again** or a board refresh; a ticket with no prototype yet shows the tab
once a later list finds one. Files over 2 MiB are refused.

Both tabs show a card's own files plus those of the cards it links with a
`relates_to` link, each labeled "From <card title>" with its round. Only the
card's own outgoing `relates_to` links count; parent, child, and blocking
links schedule work and pull in no files, and a linked card contributes its
committed rounds only. An agent links a card to the one whose files it should
show with `workboard_reference`; an operator uses the Gateway method:

```bash
openclaw gateway call workboard.cards.link \
  --params '{"id":"<card>","targetCardId":"<other card>"}'
```

`type` defaults to `relates_to`. A link to a card that was deleted, or that has
no files of that kind, shows nothing.

A project board can carry the target once as
`orchestration.defaultTarget` through `workboard.boards.upsert`. New cards on
that board copy it, including cards an agent creates with `workboard_create`
or `workboard_decompose`; agent board tools cannot set or change it. A card
keeps its own target, opts out with `target: null`, and never inherits when it
has a non-scratch workspace or a linked session. Because only operators set
targets, a sandboxed agent's cards on that board still start: node dispatch
checks the dispatcher's access, not the access of the card's creator. Set
`orchestration.defaultAssignee` too, so those cards run under the project's
agent instead of the default agent.

To send some kinds of work to a different node, add label routes as
`orchestration.targetRoutes`, also set only through `workboard.boards.upsert`.
This board runs server work on a Linux node and everything else on a Mac:

```json5
{
  id: "voice-diary",
  orchestration: {
    defaultAssignee: "dev",
    defaultTarget: {
      kind: "node-claude",
      nodeId: "mac-node",
      repoPath: "/Users/factory/repos/voice-diary",
      worktreesRoot: "/Users/factory/worktrees",
      hostRepoPath: "/home/openclaw/repos/voice-diary",
    },
    targetRoutes: [
      {
        labels: ["class:server-fix", "class:feature", "class:refactor"],
        target: {
          kind: "node-claude",
          nodeId: "linux-node",
          repoPath: "/home/factory/repos/voice-diary",
          worktreesRoot: "/home/factory/worktrees",
          hostRepoPath: "/home/openclaw/repos/voice-diary",
        },
        // Optional: at most one server ticket runs at a time.
        maxConcurrent: 1,
      },
    ],
  },
}
```

A new card takes the target of the first route that shares any of its labels;
labels match exactly. A card with no routed label gets `defaultTarget`. Routes
follow the same rules as `defaultTarget`: a card's own target, `target: null`,
a non-scratch workspace, or a linked session skips them. Saving refuses a route
with no labels and a label that appears in more than one route. Pass
`targetRoutes: null` or `[]` to remove the routes. Routing happens only when a
card is created: changing a card's labels later, or the board's routes, does
not move existing cards to another node. The one exception is a route's node
pool, below.

A route's optional `maxConcurrent` (1 to 16) caps how many of its tickets run at
once on each of its nodes, inside the plugin-wide pool. Use it when a node can
run only one ticket at a time, such as a Mac with one simulator. A ticket counts
toward the route while it is `running` on one of the route's nodes and the
route is the first one that shares its labels. The cap and the labels are read
when a ticket starts, so it also holds cards created before you set it, and
relabeling a running ticket moves it in or out of the count. A scheduled pass
skips a ticket beyond it, and an operator's **Start** or a reopened ticket
[queues](#queued-starts) until one frees.

To spread a route's work over several nodes, list the others in order as
`alternateTargets`; the route then needs `maxConcurrent`, and each node may
appear only once. A new card still copies `target`, but when it first starts,
its claim moves it to the first of `target` and `alternateTargets` whose
`maxConcurrent` slots are not all in use, in the same transaction that counts
them, so two starts never take one node's last slot. Once the ticket has a
worktree on a node it stays there through questions, review, rework, retries,
and a restart after a stop. A card on a node outside the route is not moved,
and a card moved to another node takes that node's entry as its whole target.
The choice does not check whether a node is connected (claims run in the store,
which has no Gateway access): a start on an offline node fails and blocks the
card as with a single target, and its next start may pick the same node again.
A start that fails after creating the worktree but before recording it can
leave that worktree behind when the next start picks another node.

```json5
{
  labels: ["class:server-fix", "class:server-feature", "class:server-refactor"],
  target: { kind: "node-claude", nodeId: "linux-big" /* paths as above */ },
  alternateTargets: [{ kind: "node-claude", nodeId: "linux-small" /* paths as above */ }],
  // One server ticket per node: two run at once, the big node first.
  maxConcurrent: 1,
}
```

Saving a board that sets the target, the routes, or the assignee checks each
target `model` against that agent's `modelPolicy.allow` (the default agent when
no assignee is set) and refuses a model the agent may not run, naming both. Other board edits
skip the check, so a board whose agent policy narrowed later still saves; its
cards then block at start with the core `model not allowed` reason.

A board's `orchestration.classRungs`, also set only through
`workboard.boards.upsert`, sets the trust-ladder rung of each task class (a
card's first `class:<name>` label, keyed without the `class:` prefix). A class
not listed is at rung a. Rung c is for classes trusted to merge their own
PRs: it runs every round the way rung b does (standards review, agent
decision, sampling), and Workboard merges a PR an agent accepted at c itself
(see [Auto-merge at rung c](#auto-merge-at-rung-c)):

```json5
{
  id: "voice-diary",
  orchestration: {
    classRungs: {
      docs: { rung: "b" },
      // Every PR of a rung b security class is read by a person.
      security: { rung: "b", sampleEvery: 1 },
    },
  },
}
```

`sampleEvery` (1 to 100, default 3) sizes the human review sample of PRs an
agent accepts at rung b (see **Accept** below). Saving replaces the whole map; `classRungs: null` or `{}` removes it. Saving
refuses more than 50 classes, a name with the `class:` prefix or longer than 34
characters, a rung other than `a`, `b`, or `c`, and a `sampleEvery` that is not an
integer from 1 to 100.

Each entry also carries `since`, the epoch ms when the class last changed rung.
The store stamps it when a save moves the class to another rung (an unlisted
class counts as rung a, so listing it at `a` is no change) and carries the
stored value on every other save, including one that omits it. An explicit
`since` overrides both, to backfill a change made before stamping; saving
refuses one that is not an integer from 0 to now. Each start, rework, answer, or retry reads the rung from
the board and records a rung b or c round as `rung: "b"` or `rung: "c"` on
the node worktree, so promoting or demoting a class applies from the next
round on, never to one already running. An agent decides a round that ran at
b or c while its class is at b or c. A rung b or c round's brief asks the session to run a reviewer
subagent against the repository's `CODING_STANDARDS.md` before its `done`
report, address the findings, and report them (see **Report** below).

A board's `orchestration.verifier`, operator-set the same way, runs an
independent verification of every imported round (see **Verification**
below): `{ agentId: "verifier", model: "openai/gpt-6-sol" }` names the agent
whose session verifies and the `provider/model` it runs on, which should
differ from the ticket model so the proof is re-executed by another model.
Saving refuses an empty `agentId` or a model that is not `provider/model`;
`verifier: null` removes it. Without it no round is verified.

The plugin passes the session no tool restriction: the agent's own tools are
the boundary. `agentId` must name a dedicated agent that has only `exec` and
`process`, runs its commands on the node, and never falls back to another
model, so a verdict always comes from the configured one:

```json5
// openclaw.json
{
  agents: {
    entries: {
      verifier: {
        model: { primary: "openai/gpt-6-sol", fallbacks: [] },
        tools: { allow: ["exec", "process"], exec: { host: "node" } },
      },
    },
  },
}
```

1. **Start:** the dispatcher fetches `origin` in the node clone, creates branch
   `factory/<cardId>` at `baseRef` (default `origin/HEAD`) in
   `<worktreesRoot>/wb-<cardId>`, and starts the session there.
2. **Report:** the session ends with a `workboard-report` block whose text
   fields are Markdown. A retry turn the Gateway runs in the same session
   after a stuck-session abort reports for the same round. A `done` report
   with passing proof starts the import. Its optional `headline`, one to
   three plain sentences for the operator (capped at 400 characters),
   replaces the card's [summary](#card-fields) in the same write; the longer
   `summary` is posted as a comment. A report without a headline leaves the
   summary unchanged. A `needs_input` report waits for an answer (see
   **Questions**), and a `grill` report hands a grilling off to its own
   session (see **Grilling**).
   Anything else blocks the card,
   including a `done` report with any `failed` proof entry. The brief tells the
   session to record red-first evidence (a test that failed before the fix) in
   the note of its passing entry. A rung b round's report also carries
   `"review": {"items": [{"path": "…", "line": 1, "rule": "…", "body": "…", "fixed": true}], "note": "…"}`,
   one item per reviewer finding: a repo-relative `path`, a 1-based `line`
   (for an open finding, its line number in the file at the round's final
   commit), the `CODING_STANDARDS.md` rule, and a one-line `body`. A review
   with no findings sends `"items": []`. The counts derive from the items.
   An item is dropped when it has no `path`, a `path` over 160 characters,
   or a `path` that is not repo-relative (absolute, with a `..` segment, or
   with a control character), or when it has no positive integer `line` or
   no `body`. A leading `./` is removed from the path. When items are
   dropped, the review note ends with `(N malformed findings dropped)`, so
   a review whose items were all malformed does not read as clean. A
   session resumed under an older brief may send
   `{"findings": n, "fixed": n, "note": "…"}` instead, which is still accepted.
   The review is recorded as a passed `standards review` proof entry whose
   note gives the counts, and on the round as `review` (see `rounds` in
   `workboard show --json`), keeping at most 12 items, open findings first,
   with cells cut to a short length. A `done` report without it blocks the
   card. Fewer fixed than found is recorded, not blocked.
   **Decision trail:** any report may carry an optional `decisions` array,
   one row per decision point or checkpoint of the turn (a fork chosen, a
   unit verified, a pivot or revert, a blocker):
   `{"ts": "…", "phase": "…", "decision": "…", "why": "…", "evidence": "…", "result": "…"}`.
   `phase` and `decision` are required; `evidence` is a pointer such as a
   commit SHA, `file:line`, or a command. Each cell is cut to one line and a
   short length, rows without a phase or a decision are dropped, and a round
   keeps its newest 30 rows within about 3,000 characters. Rows append to the
   round's trail across its reports (questions, answers, re-runs), so a
   blocked report's trail is kept too.
   **Questions:** a `needs_input` report posts its questions as a card
   comment and moves the card to `review`, keeping the node worktree. To
   answer, add a comment and move the card to `todo`. The same session resumes
   in the same worktree, and its brief carries the answer in full. When that
   start fails and the card is started again, the retry's brief still carries
   the answers; a rework round's retry keeps its review feedback the same way. A move to
   `todo` without a newer comment, or a move to `done`, sends the card back to
   `review` with a comment naming the next step. When the board has an
   automation job, the end of the ticket's turn nudges it, so the assignee
   agent can answer. An agent that passes the questions to the operator
   instead calls `workboard_escalate`, which records `escalatedAt` on the round
   (no comment, no move), so later automation runs can skip it; the next
   questions round starts without it. The trust KPIs count answered question rounds. A round an
   operator answered (a comment from the Control UI or the Gateway) is a human
   touch; a round an agent answered with `workboard_comment` is not.
   **Grilling:** when a ticket needs a back-and-forth with you to align on
   what to build (specification, scope, domain terms), the session does not
   grill you itself. It ends a turn with
   `{"outcome": "grill", "summary": "<handoff>"}`, where the handoff is
   readable Markdown: what it researched (facts, files, decisions already
   fixed), what is settled, the open frontier, and the first question with
   its recommended answer. The session decides when to grill; no card
   setting turns it on. The handoff is appended to the card's `grilling.md`
   attachment as `## Handoff N` (one log per card, rewritten in place and
   capped at 256 KiB: an entry that would pass the cap is cut with a note),
   and the card moves to `review` with stage `grilling`. The board's
   automation job is not woken for a grilling, and comments are not answers.
   The node handoff pass then creates the grill session: a normal session of
   the card's agent on the Gateway (not on the node, no worktree), with that
   agent's own model, under the key `agent:<agentId>:grill-<cardId8>-<N>` and
   the name `Grill <card title>`, in the session group **Grilling** (created on first use). Its first message carries the card title,
   the handoff, and the rules: interview you one question at a time with a
   recommended answer, look facts up itself, build nothing, and when you
   confirm a shared understanding, write the result handoff (settled
   decisions, agreed terms, open risks, what the ticket session should do
   next) and call `workboard_grill_done` with it. Workboard records the key
   on the card's grill (`grill.sessionKey`) and posts a comment naming the
   session. When the full log cut the handoff, the first message says so and
   points the session at the card (`workboard_read`) and the log instead. A
   pass that finds the round's session already ran a turn records it without
   sending the handoff again. If the session cannot start, the card is
   blocked with the reason; a move to `todo` brings it back to `review` and
   the next pass tries again.
   You grill in that session like in any other chat. The card's **Grilling**
   tab shows the log, **Open grill session**, and **End grilling**, and a
   grilling card opens on that tab. On the card's own session the session
   chip reads "Grilling — in Grill <card title>" and opens the grill session;
   that session stays read-only, and a turn that runs there while the card
   grills reports nothing.
   `workboard_grill_done {handoff, cardId?}` ends the grilling. Only the grill
   session recorded for the card's live grilling may call it; any other
   session is refused. It logs a `## Result` entry
   `**settled in the grill session** (<time>)` with the handoff, closes the
   grill, and moves the card to `todo`, so the ticket session resumes in the
   same worktree under `## Grilling ended` with the result, to carry out the
   ticket and end with `done`, `blocked`, or `needs_input` rather than grill
   again. End grilling calls `workboard.cards.grill.end {id}`: it reads the
   grill session's last assistant reply with `chat.history` and ends the
   grilling the same way with that reply as the result
   (`**ended by the operator**`, or "No result was handed back." when the
   session has not replied); the resumed brief says that result is the grill
   session's last reply and may be an open question rather than a decision.
   The Gateway refuses it while the grill session
   runs a turn ("The agent is still replying in the grill session; end the
   grilling when it has answered."), and unless the card is grilling. A move
   to `done` while the card is grilling does the same as End grilling, since
   there is nothing to publish yet, once the grill session is not replying:
   until then the card waits in `done` with the grilling live, and a later
   handoff pass or the sweep ends it. An ended grilling moved to `done` before
   it resumed goes back to `todo` the same way. A run that started before a
   round's claim never reports for that round. A move to `todo` while
   grilling goes back to `review` with a comment naming the grill session and
   End grilling. A `done`, `blocked`, or `needs_input` report of a claimed
   round closes an open grill with an `## Outcome` entry naming what the card
   got, so a `done` report the import refuses for its proof closes it
   `blocked`; after the grilling ended it only clears what is pending. The
   log stays on the card: the metadata budget and the 20-attachment cap drop
   other attachments first, and deleting `grilling.md` is refused.
   A card waiting on a `needs_input` round shows **Grill this** beside its
   stage. It calls `workboard.cards.grill.questions {id}`, which hands the
   round to a grill session as a `grill` report would: the handoff is the
   last `**Needs input:**` comment and every comment after it, and the card
   continues exactly like a grilling the session started. The Gateway refuses
   it unless the card waits in `review` on a questions round.
3. **Import:** the node bundles the branch to `<worktreesRoot>/wb-<cardId>.bundle`
   and the Gateway fetches it with File Transfer, so the node's
   `allowReadPaths` must cover `<worktreesRoot>/*.bundle`. The host clone
   fetches `origin` when it lacks the base commit and runs `git diff --check`
   over the ticket's commits (a rework round: only the round's own commits,
   not what a reviewer pushed). A failure adds a failed `import check` proof
   entry and blocks the card with the command first and the output in a fenced
   code block, which counts as a block in the trust KPIs; a re-run fixes it with a new commit in the same node worktree
   and imports again. Otherwise it creates `factory/<cardId>` (never moving an
   existing branch), the node worktree is removed, and the
   card moves to `review` with its claim released. The import records the
   round's changed files from `git diff --numstat -M` over the same range
   as the check: the files with the most changed lines, up to 30 and about
   1,500 characters of paths, each with its added and deleted lines (or
   `binary`) and a rename's old path, plus totals over every file. When that
   diff fails, the import still completes and the Gateway logs a warning. A
   card keeps the facts of its last five rounds; when the card's metadata
   outgrows its 24 KiB budget, round facts are dropped first, oldest round
   first, before comments or proof. The oldest round loses its decision
   trail, then its review items, and goes only after that, so its review
   findings outlast its decision trail. When the board has an
   automation job, reaching `review` nudges it, so the assignee agent can
   give a shadow verdict (see [Trust KPIs](#trust-kpis)). A first round that
   reports done without committing anything (a report-only round, such as
   "could not reproduce") has nothing to bundle: the import adds a skipped
   `bundle import` proof entry, clears the handoff, removes the node worktree
   and branch, and moves the card to `review` with its report. Moving it to
   `done` closes it without a PR, and the trust KPIs count it neither
   imported nor accepted. No verification runs for it.
   **Verification:** on a board with an `orchestration.verifier`, the import
   does not nudge the automation yet. The handoff pass first creates a
   detached worktree of the imported head in the node clone,
   `<worktreesRoot>/verify-<card8>-r<round>`, and a session of the verifier
   agent on the verifier model (key `agent:<agentId>:verify-<card8>-r<round>-v<n>`,
   where `n` counts the round's earlier runs, so each run is a fresh session;
   session group **Verification**) with the node as exec host and that
   worktree as working directory, so its commands run on the node. The
   session's brief is blind to the author: the ticket title, the card notes
   (the spec and its Proof section), the round's range, node, and working
   directory, and never the ticket session's summary, proof, decisions,
   review, or verdict. It tells the verifier to re-run the proof the notes
   name, then try to break the change (acceptance criteria with a `file:line`
   or a command, sibling entry points, async/cancel/restart state, interface
   boundaries, drift against docs or ADRs), that throwaway probes in the
   worktree are fine but committing, pushing, or touching other worktrees is
   not, that a build cache outside the worktree a proof names (such as an
   `xcodebuild -derivedDataPath <dir>`) becomes `<dir>-verify`, so it neither
   waits on ticket sessions' builds nor starts cold each time, that a proof
   run on a named simulator runs instead on a simulator the verifier creates
   (`verify-<card8>-r<round>`) and deletes before its reply, so it never
   shares one with a ticket session's test run, that `Operator-run` proof and style preferences are not failures,
   that a failure beyond the failure scope (the notes' `Failure scope:` line,
   else one fault at a time, a client cancellation, or a restart; two
   simultaneous faults or a destructive admin operation racing the change are
   beyond it) goes in the summary under `Beyond scope:` with a proposed
   follow-up card instead of a finding, and to end with exactly one
   `workboard-verification` block:
   `{"verdict": "pass|fail|error", "summary": "…", "findings": [{"path": "…", "line": 1, "body": "…"}], "visual": {"verdict": "looks_right|problem|not_checked", "screenshots": [{"path": "…", "shows": "…", "verdict": "looks_right|problem"}]}}`.
   When the proof captures screenshots, the brief tells the verifier to look
   at each one: in one Code Mode `exec` script it downscales each PNG to a
   JPEG no wider than 800 px on the node
   (`sips -Z 800 -s format jpeg -s formatOptions 65 in.png --out out.jpg`),
   base64-encodes it, and passes the `data:image/jpeg;base64,…` URL to Code
   Mode's `image()` helper, so the images come back to the model as image
   blocks without a new tool. `sips` and `base64 -i` are macOS commands; on
   a Linux node the verifier records `not_checked` unless it finds an
   equivalent. The brief also keeps what the verifier saw on screenshots out
   of `summary` and `findings`, except a defect the proof shows by other
   means (a crash, a wrong accessibility tree, a failing test). The `visual` part records, per screenshot, its
   path, what it shows (the selected tab, the text, the filled button, an
   alert, the dark-mode colors), and `looks_right` or `problem`, plus an
   overall visual verdict (at most 12 screenshots). The visual check is
   operator-run: the visual part never changes `verdict`, and a round with no
   screenshots, or a session that cannot show itself an image, records
   `not_checked`. A missing or malformed `visual` part is `not_checked`.
   The verifier reports `error` when it could not finish the proof (its node
   went away, a tool or simulator kept failing) without finding a defect; the
   result keeps its summary, drops any findings, and the operator re-runs it.
   The card holds its node-ticket slot while the verification runs (one build
   at a time on the node). Once the session has no active run, the pass reads
   the block from its last reply; a missing, doubled, or invalid block is the
   verdict `error`. It records the result on the node worktree as
   `verification` (`phase: "done"`, the verdict, summary, up to 12 findings,
   the visual read, the model), removes the verify worktree (a failure only
   warns), posts one card comment from `agent:<agentId>` whose first line is
   `**Verification:** pass|fail|error (<model>)` followed by the summary and
   findings, and only then nudges the automation. A session that cannot be
   created records `error` right away, so the card is never held by a
   verifier that cannot run. A record whose head or round is not the imported
   round's is stale: it gates nothing and the next import replaces it.
   `workboard.cards.verify {id}` (`operator.write`) drops a finished
   verification of a card in review on an imported round, and the next pass
   verifies it again in a fresh session: the way back from `error`. A
   verification still running when the round is decided, the card archived,
   or a rework round launched settles the same way once its session ends,
   and holds the card's node-ticket slot until then; a round published before
   its verification finished carries none. At rung a the verification is
   blind like the shadow verdict (see [Trust KPIs](#trust-kpis)): operator
   reads replace every verification comment since the import with a notice
   and leave the finished record out until the round is decided; a running
   record stays visible, and agents read the card whole. The verifier session
   itself is listed in the Gateway's sessions under the **Verification**
   group and is readable there, so an operator who wants a blind decision at
   rung a does not open it before deciding.
   **Visual check:** the verifier's visual read is blind at every rung until
   the operator records their own look at the screenshots: every agent tool
   and operator card read leaves `visual` out of the record, and the
   `**Verification:**` comment never carries it. Operator reads carry
   `visualCheck: {round, check?}` once the imported round's verification
   finished, even at rung a while the record itself is hidden.
   `workboard.cards.visualCheck {id, verdict: "looks_right"|"problem", note?}`
   (`operator.write`) records the check on that verification, once per
   record: a second check is refused until `workboard.cards.verify` re-runs
   the verification, whose new record takes a fresh one. It is also refused
   while the verification runs, for a stale or missing record, and on an
   archived card. Recording it reveals the read on card reads, and posts one
   operator comment: `**Visual check:** operator <verdict>`, the note, then
   `**Verifier:** <verdict>` (`no visual read recorded` for a record finished
   before the verifier wrote one) and the verifier's line per screenshot. The
   Screenshots tab then shows the recorded check read-only. At rung a, until
   the operator decides the round, operator reads show that comment with only
   the operator's verdict and note, and the verifier part reads
   `revealed when you decide this round`; once decided, the whole comment
   shows. At rung b it always shows whole. `dev` reads the comment whole, so
   at rung a it sees the operator's check before its shadow verdict; this is
   accepted, as a free-form operator comment has the same effect. A publish copies
   `visual: {verifier, operator}` into the round's `reviews` entry only when
   both exist; a round decided without a check carries no visual, the next
   import replaces the record, and the verifier's read is never revealed.
4. **Accept:** moving the card from `review` to `done` pushes the imported
   commit from the host clone to its GitHub origin and opens a draft PR, or
   reuses an open one for the branch. When the branch has no open PR but a
   merged one whose head is the accepted commit, as after a rework round that
   made no commits, nothing is pushed and no PR is opened: the card records the merged PR and gets
   a comment saying so. The PR URL is recorded as proof. When
   the card's `sourceUrl` is a GitHub issue URL, the PR body says
   `Closes <owner>/<repo>#<n>`, so merging the PR closes the issue. A
   failure, such as a missing [token](#configuration), blocks the card with
   the reason, including GitHub's validation errors; move it to `done` again
   to retry. Archive a card instead of
   moving it to `done` to close it without a PR.
   **Agent acceptance at rung b:** an agent's Workboard tools (every one that
   can set `done`, such as `workboard_move`, `workboard_release` with a
   status, and `workboard_complete`) can move an imported ticket to `done` only when the
   card's class is at rung b on the board at that moment, the round itself
   ran at rung b, and an agent posted `Verdict: accept` or
   `Verdict: rework: <finding>` since the import. On a board with a
   `verifier`, an accept also needs the round's verification to have passed:
   the move is refused while it runs ("Verification is still running; wait
   for its comment."), after a `fail` ("The verification failed: <summary>.
   Post `Verdict: rework: …` and rework it."), and after an `error` ("The
   verification could not finish (<summary>). Leave the card in review; the
   operator decides or re-runs it."). A rework verdict and an operator's move
   are never gated. Otherwise the move fails and
   names the next step: at rung a, post the verdict and let the operator
   decide. The move records `decidedBy` on the imported handoff; any later
   move to done by the operator, such as a retry after a failed publish,
   clears it. An agent's accept verdict also picks the review sample: every
   ticket that went through a rework round, and 1 in `sampleEvery` of the
   others, chosen from the card id, so the same card always gets the same
   answer. Its PR opens ready for review instead of as a draft, and the body
   says `Sampled for human review` or `Not sampled for human review`. The PR
   body and a rework round's PR comment also carry the round's
   `Standards review: <counts>` line. An agent move with a rework verdict
   publishes a draft, the step before reopening the ticket for rework. A
   reused PR is not marked ready; its rework comment carries the sample line.
5. **Rework:** to address review feedback, add a comment with the feedback,
   then move the published card back to `todo`. The move starts the rework
   round on its own; `workboard.cards.start` is not needed. Add the comment
   first: a published card moved to `todo` with no comment newer than its
   publish goes back to `backlog` with a comment naming the next step, and
   Workboard's own comments never count as review feedback. When every
   [node ticket slot](#configuration) is busy, the card joins the
   [start queue](#queued-starts) in `todo` with one comment saying it waits.
   If the start is refused for another reason, the card is blocked with that
   reason; fix it and move the card to `todo` again. The node worktree
   restarts at the PR branch tip on `origin`, so commits a reviewer pushed are
   kept. The session gets the same session key, a "Review rework, round N"
   brief with the full text of the review comments (the last five), and the
   recent comments. The import moves the host branch forward
   only from the commit it published. Accepting again pushes to the same draft
   PR, whose body stays as first written, and posts a PR comment for the round:
   the new head, commits others pushed, and the card comments since the
   previous publish (the review feedback and the session's summary). If the
   comment fails, the push still counts and the card gets a comment saying so.
   The card records `rework.round`, `rework.outsideCommits`, and the first
   acceptance (`rework.acceptedAt`) on its node worktree. A card imported but not yet published can't be reworked: Workboard
   refuses its move to `todo` or `ready` and it stays in `review`. Move it to
   `done` first. A branch that is gone from `origin` (merged or closed PR) needs a new
   card.
6. **Stop and restart:** **Stop** on a running node ticket calls
   `workboard.cards.stop {id, expectedUpdatedAt}`, which records the stop on
   the node worktree before it aborts the session. The card goes back to
   `todo` with a comment, its claim released, and its session link and node
   worktree kept. The attempt closes as `stopped`: no failure is counted, the
   card is never `blocked`, and the trust KPIs count no block. If the session
   had no active run, the call fails and the card is unchanged; a second stop
   while one is in flight returns the card as is. **Restart** on a node ticket
   in `todo` or `ready` that keeps its session link starts it again in the
   same worktree, keeping uncommitted edits. Move a `blocked` node ticket to
   `todo` first; a published or questions card then resumes on its own.

Nodes and ticket sessions never hold the GitHub token; only the Gateway's
publish step and the PR state sync read it.

<a id="pr-state-sync" />

**PR state:** the published handoff records its PR's GitHub state as
`pullRequest: {state, checkedAt}`, where `state` is `open`, `draft`, `merged`,
or `closed`. The publish sets it (`merged` when it found the merged PR that
holds the commit). Every 10 minutes the handoff pass then reads each
repository's PRs with one GraphQL query that asks only for each PR's number,
state, draft flag, and mergeability, paging back by update time until it has found every
published PR not yet seen merged or closed (at most 10 pages of 100). The REST
list is not used: its pages carry every PR body and outgrow the 1 MiB response
cap. It records only a changed state, so `checkedAt` is the read that saw the
current state, and a PR seen merged or closed is never read again. The first
read comes 10 minutes after the Gateway starts. The repository and token come
from the host clone's origin, as for the publish. A missing token, a GitHub
error such as a rate limit, or a network failure keeps the last known state and
logs a warning; the next read catches up. A merge is a GitHub fact, not the
card's verdict: the round's `reviews` entry is unchanged. Archived cards and
rework rounds in progress are not read; the next publish records the state
again. A merge read this way also records `mergedAt` and `mergeCommit`, the
commit GitHub put on the base branch.

**Regression watch (D37):** after each state read, the same pass watches every
merge with `mergeCommit` for 7 days after `mergedAt`: one paged GraphQL read
of each repository's default branch since its oldest watched merge (at most 5
pages of 100 commits). A merge regressed when a later commit reverts it (git's
`This reverts commit <mergeCommit>` line, or a title starting
`Revert "… (#<number>)"` as GitHub's revert button writes for a squash merge),
or when the merge commit's own combined checks ended `FAILURE` or `ERROR`
while its parent's ended `SUCCESS`. Pending checks or a red parent are no
regression of the merge. The watch records `pullRequest.regression`
(`{kind: "revert" | "red_main", at, commit}`) with a notice comment, once: a
recorded regression is never read again. When an agent accepted the merged
round at rung c and its class is still at c, the watch first moves the class
to rung b on the board (D37), which stamps its `since`, and records
`demoted: true`. The operator promotes it again with `workboard.boards.upsert`.
At rung b a batch merged by hand can turn red mid-batch and green at its last
commit; that counts too. `workboard.cards.dismissRegression {id}`
(`operator.write`) marks a false one `dismissedAt`: the trust KPIs then leave
it out, and a demotion it caused stays. Merges recorded before the merge facts
existed are not watched.

<a id="auto-merge-at-rung-c" />

**Auto-merge at rung c:** in the same pass, between the state read and the
regression watch, Workboard merges the PRs of done tickets whose last round an
agent accepted at rung c (`reviews` entry with `decidedBy: "agent"`,
`verdict: "accept"`, `rung: "c"`) and whose PR is open. The accept gate already
required the verdict and the passed verifications. Per repository it reads,
in one GraphQL query, the default branch head's combined checks and the oldest
10 candidates by publish time: state, mergeability, head commit, and the
head's combined checks. Then:

- The base branch head red (`FAILURE` or `ERROR`) halts the queue; the oldest
  candidate gets one notice, and the queue resumes on its own once the base
  branch is green. Anything other than `SUCCESS` holds it silently, including
  the pending checks of the merge commit the previous pass made, so PRs merge
  one at a time, each after the previous one's merge commit went green.
- A candidate whose head is no longer the commit the agent accepted
  (`head_moved`), whose checks failed (`checks_failed`), or whose head has no
  checks (`checks_missing`) is passed over with one notice per reason and
  stays open for the operator; the PRs behind it go on.
- Pending checks or a mergeability GitHub has not computed yet hold the
  queue; a conflict is the conflict rework's (above).
- The first candidate that is open, mergeable, and green merges with
  `PUT /repos/{repo}/pulls/{number}/merge` (`merge_method: "merge"`, `sha` set
  to the accepted commit, so a push that lands meanwhile makes GitHub refuse
  it). At most one PR merges per repository per pass. The merge records
  `state: "merged"`, `mergedAt`, `mergeCommit`, and `autoMerged: true` with a
  notice, and the regression watch follows it from then on.

`autoMergeWait: {reason, since}` on `pullRequest` records the reason a PR is
passed over or the queue halts, so each notice is posted once. A failure warns,
and the next pass retries. An operator's decision at c, a rework verdict, and
rounds at a or b never merge here.

**Conflicts:** when the read finds a done ticket's open PR `CONFLICTING` with
its base, Workboard reopens the ticket for a rework round in the same write:
it adds a comment asking to merge the base branch into the PR branch as a new
merge commit, resolve the conflicts, and re-run the proof, moves the card to
`todo`, and sets the handoff's `conflictReworkAt`. That comment is the round's
review feedback. It happens once per publish: a card an operator already
moved, or one sent back to done with the conflict unresolved, is left to the
operator. GitHub computes mergeability lazily, so an `UNKNOWN` PR waits for a
later read. That round does not count as a rework round in the
[Trust KPIs](#trust-kpis), even when re-running the proof commits new
evidence: its start records it in `rework.unchangedRounds`.

#### Trust KPIs

`workboard.cards.trust {boardId}` (and `workboard_stats {trust: true}` for
agents) projects node ticket facts on read. Per task
class (a `class:<name>` label, else `unclassified`) it counts tickets,
accepted (published), clean accepts (no rework round or outside commit),
first-pass imports (never blocked), blocks, rework rounds, outside commits,
and attempts. A weekly series for the last 8 UTC weeks gives the accepted
count, the **autonomous** count (accepted with no rework, outside commit, or
block), the median lead time from create to accept, and the median review
wait (`medianReviewWaitMs`): import to publish for the review rounds published
that week, the part of the lead time spent waiting for the operator (API
only; the Control UI tables do not show it yet). Rounds published before this
was recorded have no review wait. On a board with an
`orchestration.defaultTarget`, the Control UI shows "N of M autonomous this
week" under the board title; select it for the weekly and per-class tables.
Blocks come from card events, which keep the newest 50 per card. An archived
ticket counts only when its PR merged before the archive: archiving one that
never published (a probe, a duplicate, a dropped ticket) or whose PR never
merged (accepted, then dropped) removes it from every count. The
[PR state sync](#pr-state-sync) stops at the archive, so a merge it had not
recorded by then leaves the ticket out as well.
A rework round whose import adds no commit of its own besides merges (only a
merge of the base branch to clear a PR conflict, or nothing), or that the PR
state sync opened for a conflict (see **Conflicts** above), is recorded in
`rework.unchangedRounds` and is not rework: it leaves rework rounds, clean
accepts, and verdict agreement as they were. Rounds recorded before either
rule still count.

**Smart zone:** when a run ends, Workboard records its context use at turn end
on the attempt (`contextTokens`): the prompt tokens of the run's last model
call, from the usage on its last assistant message. Earlier runs in the same
session don't count, and a run that never replied stays unmeasured. A Claude
Code run that compacted mid-run reports its context after the compaction. The
counts report `contextMeasured` and `smartZoneBreaches` (runs whose context
passed `smartZoneTokens`, 150,000), and each week reports `medianContextTokens`
for the runs that ended in it. A class whose runs breach the zone needs
smaller tickets.

**Shadow verdicts:** an agent reviewing a ticket in `review` can leave a
comment starting with `Verdict: accept` or `Verdict: rework: <finding>`
before the operator acts. Markdown emphasis on the label counts too, as in
`**Verdict:** accept` or `**Verdict: rework**: <finding>`. Authority does not
change; the verdict is advisory.
The verdict is blind: Gateway and CLI card reads hide it until the operator
moves the card to `done`, so it cannot prime that decision. Agent tools still
see it.
Each accept (the publish) records the newest agent verdict since the import
and up to the move to `done`, or `missed` when none came first, in the node
worktree's `reviews` (the last 20 rounds). A round agrees when the verdict was
`accept` and the round right after it was not a counted rework round, or
`rework` and it was. A later counted round reworks the round before it only:
an accept that held through a merge-only conflict round stays agreed when a
later round reworks what the conflict round added. The counts report `verdictRounds` and
`verdictAgreedRounds` per round, `verdictCards` and `verdictAgreedCards` for
tickets whose every round had a verdict and every verdict agreed, and
`verdictMissed` rounds, which count in neither rate, with `verdictMissedRecent`
for those among the newest 10 rounds by publish time. A round accepted and then
reopened later counts as reworked once its rework round starts. These counts
cover only rounds the operator moved to `done`.

**Agent acceptance:** rounds an agent accepted at rung b record
`decidedBy: "agent"` and `sampled` in `reviews`. The counts report
`agentAccepts`, `reworkedAccepts` (accepted, then the next round was a
counted rework round: a person disagreed), `sampledRounds`, and `sampledAgreed` (sampled and never
reworked). Whether a person merged an unsampled PR without reading it needs
GitHub state that the projection does not have. On a one-board projection
(`boardId` set), each class row carries the board's `rung` for that class.

**Verification:** a publish copies the round's finished verification into its
`reviews` entry as `verification: {verdict, model}`, and the round's rung as
`rung: "b"` or `rung: "c"` when it ran there. The counts report `verifiedRounds` and
`verifierFailed` (verdict `fail`), then score the verifier against the person
who decided without seeing it: `verifierScoredRounds` are verified rounds an
operator decided at rung a (a rung b round shows the operator its
verification, so their decision is not independent of it) plus sampled agent
accepts (an agent's rework after a `fail` agrees with itself and is not
scored), `verifierAgreedRounds` those where `pass` met no rework or a
non-pass (`fail` or `error`) met one (the round right after, as for
verdicts), `verifierEscapes` the `pass` verdicts a
person then reworked, and `verifierCatches` the non-pass verdicts a person
then reworked. These flow through `blind` and `sinceRung` like every other
count, so a class's verifier agreement at its current rung is read from
`sinceRung`.

**Visual agreement:** `visualRounds` counts published rounds whose `reviews`
entry carries a visual check with a verifier read other than `not_checked`,
and `visualAgreedRounds` those where the verifier's visual verdict matched
the operator's. Rounds decided without a visual check count in neither.

**Regressions:** `regressions` counts merged tickets with a recorded,
undismissed regression (see the regression watch above). It belongs to the
ticket's last published round, the one its PR merged with, so `blind` and
`sinceRung` count it only where that round counts. The rung c entry bar reads
it from `sinceRung` (zero since the promotion).

**Blind counts:** each class row also carries `blind`, the same counts over
rounds published since the blind verdict went live (2026-10-11 13:01 CEST),
split by the rung that decided each round: `blind.b` and `blind.c` for rounds
an agent decided at that rung (an agent's round recorded before rung c counts
at b), `blind.a` for the rest. A rung leaves its key out when the class had
no blind round there. A ticket counts as accepted in a rung when its first
publish was decided there, so a class demoted from b to a keeps its rung b
acceptances apart from the rung a ones. Rework, blocks, and attempts stay
ticket-wide.

**Since the rung changed:** on a one-board projection, a class whose rung
entry has `since` also carries `rungSince` (that value) and `sinceRung`, the
same counts over rounds published at or after it, scoped like `blind`. A
class without `since` has neither. Checks that judge a class at its current
rung read `sinceRung`: the demote check (`reworkedAccepts` of a rung b
class) and the re-entry count after a demotion. A class promoted back to rung
b then starts from zero instead of its old reworked accepts.

Node tickets share one pool instead of their owner's single slot: up to
`nodeTickets.maxConcurrent` (default 2) run at once across all nodes, even for
the same agent. A ticket holds its pool slot only while it is `running`
(including the import). In `review` it waits for a person, so an un-accepted
draft PR never holds back the next ticket. A scheduled pass skips a ticket
beyond the pool until a slot frees. A route can set its own lower cap; see
`maxConcurrent` under the label routes above.

<a id="queued-starts" />

#### Queued starts

When the operator starts a node ticket (**Start** in the Control UI, or
`workboard.cards.start`) while its parents are not done, or while the pool or
the ticket's route is full, the card is queued instead of refused. It waits in
`todo` (or `ready`); a card started from `backlog` moves to `todo` as it
queues. One comment names the unfinished parents, or the route or node, it
waits for, the card shows a **Queued** chip, its start controls are disabled,
and `workboard.cards.start` returns `{ queued: true, card }`. A reviewed
rework or answer reopen that finds no free slot joins the same queue. A
published or questions ticket without a review comment or answer is not
queued; it goes back with the next step as described in the rework step above.
A first round also waits until each `done` node-ticket parent's PR is merged.
Its worktree starts from the default branch, so a ticket started before that
merge builds without its parent's work and duplicates or conflicts with it. A
parent PR closed without merging releases the wait, and a rework round, which
continues its own branch, never waits for one. A scheduled pass that finds a
`ready` ticket in this state queues it the same way, and its comment names the
PRs. The [PR state sync](#pr-state-sync) reads GitHub every 10 minutes, so
the ticket starts up to 10 minutes after the merge.
A first round with `touches` (repo-relative files or directories the ticket
will change, set on create, specify, decompose, or `workboard.cards.update`)
also waits while another open node ticket touches an overlapping path: a
directory covers everything under it. Open means picked in the same pass, or
started (it has a worktree) with a PR that is not merged or closed. Siblings
that change one file then land one by one instead of conflicting on each
merge. The comment names each ticket and the shared path. Archiving the other
ticket releases the wait, and a rework round never waits.
Only unfinished parents, unmerged parent PRs, open tickets on the same paths,
and a full slot queue a start: a
blocked card, one
scheduled for later, or one out of retries is refused with that reason and not
queued. Queued is not the `scheduled` status, which holds a card until its
scheduled time.

Whenever a card changes, such as a running ticket reaching `review`, Workboard
starts queued tickets oldest request first. A ticket whose parents are not all
`done` and merged, or whose own route is still full, keeps its place without holding back
a later ticket on a route with a free slot, so a full Mac route never blocks
the Linux pool. A slot that frees while a pass walks the queue stays for the
oldest request waiting on it: the pass skips later requests on a slot an older
one found full, and the change that freed it starts the next pass. A card
edited while its queued start reads it stays queued and is tried again on the
next change. A queued start refused for another reason
blocks the card with that reason.

The request is stored as `metadata.automation.startRequest`. Only the
operator's start, a reviewed reopen and a scheduled pass waiting on parent PRs
set it; card updates, agent tools, and
creates cannot. To cancel a queued start, move the card to `backlog`. Moving it
away from `todo` or `ready`, archiving it, or a claim drops the request, and
moving the card back does not restore it; start it again to requeue.

#### Probes

A probe re-runs a past node ticket under a named harness arm, so a harness
change (a brief line, a model, a skill) is judged on the same task instead of
on different cards before and after the change. Create one with
`workboard.cards.probe {id, arm, model?, note?, start?}` (`operator.admin`),
where `id` is a node ticket that ran (it records a base commit) and `arm`
matches `^[a-z0-9][a-z0-9-]{0,31}$`. The probe card is a new `todo` card on
the same board with the same assignee, titled `[PROBE:<arm>] <source title>`.
Its notes are the source's notes, with `note` as a last paragraph when given,
so a trial's `**Mode:** …` line reaches one arm only. Its labels are the
source's minus any `trial:*` label, plus `probe` and `probe:<arm>`. Its
target is the source's node target with `baseRef` set to the source's base
commit and `model` set when given; the dispatcher fetches that commit from
origin when the node clone lacks it, as after a force-push. A probe stays on
its source's node even on a pooled route. One unarchived probe exists per
source and arm: a repeat returns it (`created: false`), and with `start: true`
starts it while it is still in `todo`, queued like any start when the slots
are full. The probe is recorded as `metadata.automation.probe`
(`{of, arm, createdAt}`), which only this method sets.

A probe runs like any node ticket through its import and, on a board with a
verifier, its verification. Then the handoff pass archives it with a notice
naming the outcome and the verification verdict instead of nudging the
automation. A probe that stops with questions or a grilling is archived with
that outcome, since nobody answers a probe, and its node worktree is removed.
A blocked probe stays blocked for the operator. A probe never publishes, even
when the operator moves it to `done`; moved there while its verification
runs, it is archived once the verification settles. No agent can move it ("Probe cards are
not reviewed."); its verification is never hidden, since nobody decides its
round; the trust KPIs leave it out; and the Factory overview shows it only in
flight, never as waiting on the operator.

`workboard.cards.probes {boardId?, of?}` (`operator.read`) lists the probe
cards, archived ones included, the arms of one source together: for each, the
source card and how it fared by the trust KPIs' facts (`accepted`, `clean`,
counted `reworkRounds`), the arm, status, outcome
(`done|needs_input|grill|blocked|running`), verification verdict and finding
count, attempts, the largest turn-end context, the run time from the first
start to the last run's end, and the model.

### Worker selection

Each pass starts **at most 3 workers by default**. Ready cards are ordered by
priority, then position, then creation time. A pass starts only one card per
owner/agent and skips owners that already have running or review work on the
board. [Node tickets](#node-tickets) use their own pool instead. Archived cards, cards with an active claim, and cards not in `ready`
status are never selected for worker starts (they can still be affected by the
data side of dispatch: stale-claim cleanup, dependency promotion, timeout
cleanup).

Session keys are fixed per board/card, so repeated dispatches route
back to the same worker lane instead of creating unrelated sessions:

- Assigned cards: `agent:<agentId>:subagent:workboard-<boardId>-<cardId>`
- Unassigned cards: `subagent:workboard-<boardId>-<cardId>` (Gateway resolves
  the configured default agent)

If a worker cannot be started after a card is claimed, Workboard blocks the
card, clears the claim, records the run-start failure, and appends a worker
log line - visible in the Control UI, CLI JSON, agent tools, and card
diagnostics.

### Entry points

- Control UI dispatch action
- `openclaw workboard dispatch`
- `/workboard dispatch` on a command-capable channel

All three use the Gateway subagent runtime when the Gateway is available. The
CLI has one operator fallback: if the Gateway call fails with a
connection/unavailable error (or an `unknown method` error for older
Gateways), and no explicit `--url`/`--token` target and no configured remote
Gateway (`OPENCLAW_GATEWAY_URL` or `gateway.mode: remote`) apply, the CLI runs
data-only dispatch against local SQLite state - it can promote dependencies,
clean stale claims, and block timed-out runs, but cannot start workers. Auth,
permission, and validation failures from a reachable Gateway are not treated
as unavailable. They surface as command errors, and so does any Gateway
failure when an explicit `--url`/`--token` target was given.

Board metadata can set `autoDecompose`, `autoDecomposePerDispatch`,
`defaultAssignee`, and `orchestratorProfile`. New cards created without an
`agentId` (and without a linked session) are assigned to `defaultAssignee`.
OpenClaw records the other settings as intent and exposes them in worker
context. Actual specification/decomposition still runs through the normal
Workboard tools. The operator-only `defaultTarget` and `targetRoutes` are
described under [Node tickets](#node-tickets).

## CLI and slash command

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create "Fix stale card lifecycle" --priority high --labels bug,workboard
openclaw workboard show <card-id> [--json]
openclaw workboard move <card-id> --status <status> [--json]
openclaw workboard dispatch [--board <id>] [--json]
```

`list` text output hides archived cards by default (`--include-archived`
overrides). `--json` always includes archived cards, matching the full-card
contract used by existing scripts. `show` and `move` accept an unambiguous id
prefix. `list`, `create`, `show`, and `move` access local plugin state directly.
Stop the Gateway before local `create` or `move`; while it is running, use the
Control UI or Gateway RPC for mutations. Only `dispatch` calls the running
Gateway, with the fallback described above. Data-only dispatch also requires the
Gateway to be stopped; a connection error alone does not establish that it stopped.
Plugin loading can also initialize or upgrade the local database before choosing
the subcommand. Do that preparation with the Gateway stopped, including when the
requested command is `list` or `show`. Use the Control UI or Gateway RPC for online
access when local state still needs preparation.

See [Workboard CLI](/cli/workboard) for full flags, JSON output, Gateway
fallback behavior, id-prefix handling, dispatch selection rules, and
troubleshooting.

`/workboard list`, `/workboard show <card-id>`, `/workboard create <title>`,
`/workboard move <card-id> --status <status>`, and `/workboard dispatch` mirror
the CLI. List and show are read operations for any authorized command sender.
Create, move, and dispatch require owner status on chat surfaces, or a Gateway
client with `operator.write`/`operator.admin`. Manual operator moves use the
same claim-override behavior as Control UI drag-and-drop. Their worktree access
still follows the same workspace boundary described above.

## Session lifecycle sync

Cards can link to an existing Control UI session, or one created when you
start work from the card. Linked cards show the session lifecycle inline:
running, stale, linked idle, done, or failed. You can also capture an
existing session from its header or the Sessions tab with **Add to Workboard**. The card
links to that session, uses the session label or recent user prompt as title,
and seeds notes from the recent user prompt plus the latest assistant response
when available.

Capture keeps the destination board selected when you start the action. It
reloads an inactive board's cards before reusing one, restores an archived
exact match, and never infers session ownership from a provisional link.

Captured sessions show **Open Workboard card** and a linked-card chip. Both use
the same card state, including after a browser reload. Opening a card outside
the current agent filter switches the board to **All agents** without changing
the selected chat agent.

Opening a card loads its linked session details independently of the sidebar's
agent filter and pagination. While details are loading or unavailable, the
card keeps its link and shows **Session state unknown** or **Session
unavailable**. An ambiguous provisional link shows **Session link ambiguous**.
Edit the card to select an exact session. Use **Refresh** to retry. To continue
an existing session, select its exact link in **Edit card** and choose **Open
session**. To start fresh, clear the link in **Edit card**. Clearing the link
retains its task association, so **Start** remains unavailable while that task
is active or unresolved. Changing a card's assignee does not change the owner
of its existing session.

Bare `global` and `unknown` links do not identify a session owner. They show
**Session link ambiguous** when opened. Use **Edit card** to select an explicit
session. Workboard does not offer these bare links for new captures or links.

If an active linked session stops reporting recent activity, Workboard marks the card
`stale` and stores that as metadata until the lifecycle clears it.

Lifecycle writes are owned by the Gateway-side Workboard plugin, so they do
not depend on an open browser tab. Subagent completion hooks persist terminal
outcomes immediately. Agent attempt hooks consult the linked session state:
finishing a model attempt does not move a card into `review` or `blocked` while
its run is still active. A bounded session sweep runs once per minute to reconcile
terminal, active, idle, missing, and stale session state. Each store mutation emits
the normal `plugin.workboard.changed` invalidation, so an open Workboard tab reloads
the stored card instead of writing its own lifecycle projection.

Archiving a linked session does not hide its terminal outcome from this sweep.
After a restart or missed completion hook, Workboard still reconciles active cards linked
to archived sessions into `review` or `blocked`.

Incognito sessions remain absent from session discovery. Explicitly linked
Incognito cards use authorized exact-session metadata reads, without derived
titles or message previews, to reconcile their terminal outcomes.

While a card is in an active work state, Workboard follows the linked session:

| Linked session state                  | Card status |
| ------------------------------------- | ----------- |
| active                                | `running`   |
| completed                             | `review`    |
| failed, killed, timed out, or aborted | `blocked`   |

**Manual review states win.** Moving a card to `review`, `blocked`, or `done`
stops auto-sync for that card until you move it back to `todo` or `running`.

Starting a card uses normal Gateway sessions. Workboard only stores card
metadata and links. Conversation transcript, model selection, and run
lifecycle stay owned by the regular session system. Use **Stop** on a live
linked card to abort the active run - Workboard marks that card `blocked` so
it stays visible for follow-up. A stopped node ticket goes back to `todo`
instead (see [node tickets](#node-tickets), step 6).

New cards can start from Workboard templates (`bugfix`, `docs`, `release`,
`pr_review`, `plugin`). Templates prefill title, notes, labels, and priority.
The template id is stored as card metadata.

<a id="dashboard-workflow" />

## Control UI workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, optional agent, and
   optional linked session - or open Sessions and choose **Add to Workboard**
   for an existing session.
3. Drag the card between columns, or focus its compact status control and use
   the menu or ArrowLeft/ArrowRight. During a drag, the source card dims and
   available drop columns gain an outline.
4. Start an unlinked card when it has no active or unresolved task association.
   An autonomous start keeps you on the board; opening a card manually in an
   engine opens its session. A node ticket started while its slot is full is
   [queued](#queued-starts).
5. Read where a card stands from its summary and [status line](#card-stage);
   open the linked session from the card while the agent works. For a
   [node ticket](#node-tickets), the card's Activity tab shows each round,
   newest first: the files its import changed with +/- bars and totals, and
   its session's decision trail.
6. Let lifecycle sync move running work into `review`/`blocked`, then manually
   move the card to `done` when accepted.

<a id="factory-overview" />

### Factory overview

**Workboard → Overview** shows the whole factory on one page for an operator
who does not follow each step. Four bands list the cards across every board:

| Band              | Shows                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you         | Cards waiting on you, oldest first: a review only you may accept (rung a, a plain card in `review`, or a rung b round whose class was demoted since or whose board has no automation job), a PR an agent accepted into the human review sample, [questions](#node-tickets) escalated to you or with no automation job to answer them, grillings, and blocked cards. |
| In flight         | Queued and running cards, and node tickets waiting on an agent (a rung b review or questions the board's automation job takes, or a draft an agent published with a rework verdict before it reopens the ticket), with the node, rework round, and the last run's turn-end context.                                                                                 |
| Shipped this week | Node tickets published and other cards done in the last 7 days, newest first: the PR, review rounds, who accepted it, whether it is in the review sample, and the agent's shadow verdict on a round you accepted.                                                                                                                                                   |
| Insights          | Backlog cards labeled `gardener` or `architecture`, newest first.                                                                                                                                                                                                                                                                                                   |

Each row shows the title, the [summary](#card-fields), the
[status line](#card-stage) with its age, and a reason, label, or details line.
The title opens the card's details on its board, after the board's cards load.
The header counts unarchived cards per status and this week's accepted tickets
from the [trust KPIs](#trust-kpis), which count as `workboard.cards.trust`
does. Rows and the status counts leave out archived cards and cards on archived
boards, and an agent's pending verdict never shows. Whether you agreed with a
shadow verdict shows in the trust KPIs once a later rework round does or does
not follow. A sampled PR stays in **Needs you** until you press **Mark read**
on its row, the [PR state sync](#pr-state-sync) sees it closed or merged (a
PR merged at rung c merged without your read, so it stays until you read it),
or for 7 days after its publish. **Mark read** calls `workboard.cards.sampleRead {id}`
(`operator.write`), which records `readAt` on the round's entry in `reviews`;
the first read of a round stands, and a rework round's next publish waits for
its own read. The method refuses a card whose latest published round is not an
agent accept in the sample.

The page reads `workboard.overview {boardId?}` (`operator.read`) and reloads on
each `plugin.workboard.changed` event. The method projects the same cached
operator read as `workboard.cards.list`, so it stores nothing and adds no card
read of its own. It returns `needsYou`, `inFlight`, `shipped`, and `insights`
rows (`cardId`, `boardId`, `title`, `summary`, `stage`, plus the band's fields),
`open` counts per status (`done` excluded), and the current trust KPI `week`.
Without `boardId` it covers every board, and `boardId` reports as `all`.

### Session-board widgets

Workboard ships three native widgets for session dashboards (see
[Dashboards](/web/dashboards)). The agent pins them with its `dashboard` tool
using `content: { kind: "plugin", pluginKind, props }`, and they render as
first-party UI with live data — no sandbox frame or capability grant:

- `workboard:card` with `props: { cardId }` shows one card with its status
  control, priority, and assigned agent.
- `workboard:board` with optional `props: { boardId }` shows the full Kanban
  board with draggable cards and status controls. Without `boardId` it shows
  every board. With `boardId` it shows only that board.
- `workboard:mini` with optional `props: { boardId, limit }` shows per-status
  counts plus the top ready/running cards, and links to the full board page.
  Without `boardId` it aggregates every board. With `boardId` it scopes to that
  board (cards created without an explicit board id live on `default`).

## Diagnostics

Diagnostics are computed from local card metadata. Built-in checks flag:

| Kind                        | Condition                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ |
| `stranded_ready`            | Assigned `todo`/`backlog`/`ready` card not updated in over 1 hour.             |
| `running_without_heartbeat` | `running` card with no claim heartbeat or execution update in over 20 minutes. |
| `blocked_too_long`          | `blocked` card not updated in over 24 hours.                                   |
| `repeated_failures`         | Card's tracked failure count reaches 2 or more.                                |
| `missing_proof`             | `done` card with no proof, artifacts, or attachments.                          |
| `orphaned_session`          | `running` card with a `sessionKey` but no `execution` metadata.                |
| `archived_but_active`       | Archived card remains in any non-`done` lifecycle status.                      |

## Permissions

Gateway RPC methods live under `workboard.*`. Sessions board methods use the same
read/write scopes as boards:

| Scope            | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`  | `cards.list`, `cards.export`, `cards.diagnostics`, attachment list/get, notification event reads, `boards.list`, `cards.stats`, `cards.trust`, `cards.runs`, `cards.probes`, `overview`, `transcriptViewer`, `officeViewer`, `architectureViewer`                                                                                                                                                                                                                                           |
| `operator.read`  | `sessionsBoard.read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `operator.write` | `cards.diagnostics.refresh`, create/captureSession/update/move/delete/comment/link/linkDependency/proof/artifact, attachment add/delete, worker log, protocol violation, claim/heartbeat/release/promote/reassign/reclaim/complete/block/unblock/start, `cards.sampleRead`, `cards.dismissRegression`, `cards.verify`, `cards.visualCheck`, `cards.dispatch`, `cards.bulk`, archive, `boards.upsert`/`archive`/`delete`, `cards.specify`/`decompose`, notification subscribe/delete/advance |
| `operator.write` | `sessionsBoard.update`, `sessionsBoard.move`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `operator.admin` | `cards.probe`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`workboard.cards.update`, `workboard.cards.move`, `workboard.cards.archive`, and
`workboard.cards.delete` accept an optional `expectedUpdatedAt` request field.
Pass the finite numeric `updatedAt` from the card you read to guard the write.
If the card has changed, the request fails with `workboard_conflict` and returns
its latest card in `error.details.card` (`error.details.type` is
`workboard_card_conflict`). Review that card before retrying. Omitting the field
keeps the method's existing unguarded request behavior.

Control UI bulk actions use each card's observed revision and stop on a conflict.
Remaining cards stay selected for review and retry; the batch does not silently
retry against newer revisions or overwrite another client's changes.

Only `cards.probe` requires `operator.admin`: a probe starts code on a node,
which needs unrestricted dispatch. Browsers connected with read-only
operator access can inspect the board but cannot mutate cards. An admin scope
widens accepted Workboard host paths. It does not change the methods available.

## Storage

Workboard stores durable data in a plugin-owned relational SQLite database
under the OpenClaw state directory: boards, cards, labels, lifecycle events,
run attempts, comments, dependency links, proof, artifact references,
attachment metadata and blobs, diagnostics, notifications, worker logs,
protocol state, and subscriptions all live in Workboard tables (not
plugin key-value entries). A card export preserves the board narrative
without inlining attachment blob contents.

Sessions boards add optional `kind` and `sessions_spec` columns to
`workboard_boards`, plus `workboard_session_placements` for operator pins.
Existing board rows are not backfilled;
an absent kind still means a Cards board. Rolling back to a release without Sessions
boards shows each Sessions board as an empty Cards board and ignores the placement
table; cards created against it there are rejected once the newer release runs again. Session transcripts and the Board agent
conversation remain in the normal session store.

SQLite opening, queries, and transactions run in a background database worker.
Disabling or reloading the plugin drains admitted storage work before closing
its connections.

Workboard instances invalidate cached card lists and board revisions using the
physical database's in-process writer receipts, including commits through sibling
instances. Card-list reuse checks that receipt; an unsettled receipt leaves the
read uncached. A read overlapping a mutation can return its older snapshot; the
next request observes the writer receipt and reloads it. Change notifications use owner publications;
there is no timer polling SQLite for writes from other processes. If a worker
reply fails after a possible commit, the owner discards cached facts and rereads
them on the next use without replaying the mutation.

Installations with retained pre-July 2026 Workboard plugin-state KV data must
upgrade through OpenClaw `2026.9.7` and run `openclaw doctor --fix` before upgrading
to the latest version. Current Doctor reports this requirement without changing
the legacy rows; current relational SQLite stores remain supported.

## Troubleshooting

**The tab says Workboard is unavailable**

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to it. If `plugins.deny`
contains `workboard`, remove it before enabling the plugin.

**Cards do not save**

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

**Starting a card does not open the expected session**

Check the card's agent id and linked session, then open Sessions or Chat to
inspect the actual run state.

**Dispatch does not start a worker**

Confirm there is at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

If the CLI reports data-only dispatch, start or restart the Gateway and
retry - data-only dispatch updates local board state but cannot start
subagent worker runs. Cards can also be skipped when another card for the
same owner or agent is already running or waiting for review. Complete,
block, or release that active work before dispatching more for the same
owner.

## Related

- [Control UI](/web/control-ui)
- [Workboard CLI](/cli/workboard)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
- [Managed worktrees](/concepts/managed-worktrees)
- [Workboard build nodes](/plugins/workboard-node-setup)
