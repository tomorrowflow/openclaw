# Handoff: CodeBoarding as input to the weekly architecture pass

Status: parked on 2026-10-15 after one trial run. Resume once voice-diary's
`server/` has moved on (several merged factory PRs, or the
`docs/handoffs/01-server-diary-pipeline.md` work in voice-diary has landed), so
an `incremental` run has real deltas to show.

## What CodeBoarding is

[CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (MIT, Python 3.12,
v0.15.1). Language servers build a call graph, then an LLM groups the code into
named components with descriptions and relations. Output is
`.codeboarding/analysis.json` plus `health/health_report.json`, which covers
function size, package cycles and unused code. `incremental` diffs the working
tree against a stored baseline. The open-source engine has no UI: the explorer
and PR review views are the hosted app.codeboarding.org and the VS Code
extension. `codeboarding-render --format md|html` renders static docs.

No Swift support, so voice-diary's `ios/` and the `contract` task class are
invisible to it.

## Fit in the factory (decided)

- **Use:** deterministic input for the weekly architecture pass, cron
  `8bba3c26` (`dev`, Sundays 04:00). That cron follows the "Architecture pass
  (weekly)" section of the `workboard-ticket` skill and
  `references/voice-diary.md`. Feed it the health report and the
  week-over-week `analysis.json` delta: new cycles, new component edges, and
  functions growing past the size threshold.
- **Don't:** use the LLM-written component prose as ticket context (tier 0 or
  `CLAUDE.md`), or gate PRs on the map, because component names and grouping
  are not stable. A real boundary rule belongs in lint, per the enforcement
  ladder in `software-factory/openclaw-dev-loop-draft.md`.
- **Parked option, don't build unprompted:** render the map into the Workboard.
  The user declined a standalone viewer service.

## How to run

The image and compose file are in this directory. Clones and their baselines
live in `~/codeboarding/repos`; override the path with `CODEBOARDING_REPOS`.

```bash
cd deploy/codeboarding
docker compose build
docker compose run --rm codeboarding full --local /repos/voice-diary/server
docker compose run --rm codeboarding incremental --local /repos/voice-diary/server
docker compose run --rm --entrypoint codeboarding-render codeboarding \
  /repos/voice-diary/server/.codeboarding/analysis.json --format md \
  --output-dir /repos/voice-diary/server/.codeboarding/docs
```

`AGENT_MODEL=<ollama model>` picks the model. `glm-5.3:cloud` sends code
excerpts to Ollama Cloud. Local `gemma4:12b` keeps code on the host but is
CPU-only and slow. Telemetry is off in the image (`DO_NOT_TRACK=1`).

## Trial baseline (voice-diary `server/` at 55f7fa0)

Results are in `~/codeboarding/repos/voice-diary/server/.codeboarding/`
(`analysis.json`, `health/health_report.json`, `docs/overview.md`). That
directory is the baseline for `incremental`: `git pull` the clone, then run
`incremental`. Never run `full` again over it, or the baseline is lost.

- Cost: 6.5 min, about 175k `glm-5.3:cloud` tokens over 8 calls; 45 of 121
  files analyzed (tests, docs and config skipped).
- Map: 5 top components plus 9 subcomponents and 27 relations. The relations
  are import-backed and accurate. The grouping follows file names, not domain
  seams, so some names are weak.
- Health findings, checked in code and absent from voice-diary's docs:
  - `detect_entities` is 407 lines (`webapp/entity_detector.py`), and
    `generate_narrative_document`, `analyze_transcript` and `submit_review`
    are each over 150 lines.
  - Package cycle `webapp.routers -> webapp -> webapp.routers` (`main.py`
    imports the routers; the routers import flat `webapp` modules).
  - `webapp/upstream_failure.py`, an error-mapping helper, imports
    `enrichment`, `lightrag_client` and `ollama_client`.
  - `webapp/static/app.js` has a 307-line `dblclick` handler, a 183-line
    `startProcessing` and 6 unused variables.

## Next steps

1. Update the clone, then run `incremental` and the render. Check that
   component IDs and names stay stable against the baseline. If they churn,
   the delta can't drive the pass; fall back to the health report alone.
2. Compare the delta with what cron `8bba3c26` produced over the same weeks.
   Did CodeBoarding surface anything the agent's own scan missed? The trial's
   health findings are the first test cases: did any become cards?
3. If it adds signal, decide where the run lives. Options: a host step before
   the cron, or a host-bridged tool for `dev`, which can't reach host Docker
   (see the `sandbox_host_capability_bridge` note: never mount docker.sock).
   Then extend the skill section to read the delta, keeping the
   2-card limit.
4. Ask the user about any paid or external piece first (CodeBoarding's
   GitHub Action, the hosted platform).

## Suggested skills

- `pstack:poteto-mode`: routes the step 3 design choice (where the run
  lives, how `dev` consumes it).
- `mattpocock-skills:improve-codebase-architecture`: if a delta finding
  becomes a deepening candidate for voice-diary.
- `mattpocock-skills:grill-with-docs`: if the user wants to settle the
  architecture-pass contract before wiring anything.
