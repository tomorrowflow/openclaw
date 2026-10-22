/** The Card states board's node ticket with a live and a committed prototype. */
export const workboardPrototypeCard = {
  metadata: {
    automation: {
      boardId: "card-states",
      target: {
        kind: "node-claude",
        nodeId: "mock-node",
        repoPath: "/repos/app",
        worktreesRoot: "/worktrees",
        hostRepoPath: "/host/repos/app",
        worktree: {
          path: "/worktrees/wb-state-prototype",
          branch: "factory/state-prototype",
          baseCommit: "4f1c2a9e0b7d",
        },
      },
    },
  },
  rounds: [
    {
      round: 0,
      changes: {
        from: "4f1c2a9e0b7d",
        to: "b71d0c33e9fa",
        files: [{ path: "docs/prototypes/ONB-4/checklist.html", added: 64, deleted: 0 }],
        totals: { files: 1, added: 64, deleted: 0 },
      },
    },
  ],
};

/** Prototype list and read responses for that card; other cards list nothing. */
export function workboardPrototypeResponses(baseTime: number) {
  return {
    "workboard.cards.screenshots.list": { committed: { state: "available", rounds: [] } },
    "workboard.cards.prototypes.list": {
      cases: [
        {
          match: { id: "state-prototype" },
          response: {
            committed: {
              state: "available",
              rounds: [
                {
                  round: 0,
                  commit: "b71d0c33e9fa",
                  paths: ["docs/prototypes/ONB-4/checklist.html"],
                },
              ],
            },
            live: {
              state: "available",
              files: [
                {
                  path: "docs/prototypes/ONB-4/checklist-v2.html",
                  bytes: PROTOTYPE_HTML.length,
                  mtimeMs: baseTime - 60_000,
                },
              ],
            },
          },
        },
      ],
    },
    "workboard.cards.prototypes.get": { html: PROTOTYPE_HTML },
  };
}

/** A self-contained interactive prototype like a node ticket commits under docs/prototypes/. */
const PROTOTYPE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Onboarding checklist</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 0; padding: 28px; color: #1f2933; background: #f7f8fa; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.lede { margin: 0 0 18px; color: #52606d; }
  .bar { height: 8px; background: #e4e7eb; border-radius: 4px; overflow: hidden; margin-bottom: 18px; }
  .bar i { display: block; height: 100%; width: 0; background: #2f80ed; transition: width .2s; }
  li { list-style: none; margin: 0 0 10px; }
  button { width: 100%; text-align: left; padding: 12px 14px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; font: inherit; cursor: pointer; }
  button.done { border-color: #3ebd93; background: #effcf6; text-decoration: line-through; color: #52606d; }
  #status { margin-top: 14px; font-weight: 600; }
</style></head>
<body>
  <h1>Welcome aboard</h1>
  <p class="lede">Finish these steps to set up your workspace.</p>
  <div class="bar"><i id="progress"></i></div>
  <ul id="steps">
    <li><button>Connect your calendar</button></li>
    <li><button>Invite a teammate</button></li>
    <li><button>Create your first board</button></li>
  </ul>
  <div id="status">0 of 3 done</div>
  <script>
    const buttons = [...document.querySelectorAll("#steps button")];
    const render = () => {
      const done = buttons.filter((b) => b.classList.contains("done")).length;
      document.getElementById("progress").style.width = (done / buttons.length) * 100 + "%";
      document.getElementById("status").textContent =
        done === buttons.length ? "All set! 🎉" : done + " of " + buttons.length + " done";
    };
    for (const b of buttons) b.addEventListener("click", () => { b.classList.toggle("done"); render(); });
    buttons[0].click();
  </script>
</body></html>`;
