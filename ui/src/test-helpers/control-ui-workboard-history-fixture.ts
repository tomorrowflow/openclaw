import { createControlUiChatHistoryMessage as chatHistoryMessage } from "./control-ui-session-fixtures.ts";

export function buildWorkboardCardSessionHistories(
  baseTime: number,
  cardSessions: readonly { key: string }[],
  keys: {
    brief: string;
    launch: string;
    staging: string;
    handoff: string;
    onboarding: string;
    accessibility: string;
  },
) {
  const history = (...messages: Parameters<typeof chatHistoryMessage>[]) => ({
    messages: messages.map((message) => chatHistoryMessage(...message)),
  });
  return {
    ...Object.fromEntries(
      cardSessions
        .filter((session) => session.key.includes(":card-states-"))
        .map((session) => [
          session.key,
          history([
            "user",
            "Synthetic card-state example: inspect this execution and its recorded outcome.",
            baseTime - 700_000,
          ]),
        ]),
    ),
    [keys.brief]: history([
      "user",
      "Draft this week's product brief from the latest feedback and delivery notes.",
      baseTime - 2 * 60_000,
    ]),
    [keys.launch]: history(
      [
        "user",
        "Prepare the launch readiness checklist. I will provide the release scope before we start.",
        baseTime - 15 * 60_000,
      ],
      [
        "assistant",
        "The checklist outline is ready. Share the release scope when you are ready to continue.",
        baseTime - 12 * 60_000,
      ],
    ),
    [keys.staging]: history(
      [
        "user",
        "Confirm that the staging environment is accessible for the release review.",
        baseTime - 7 * 60_000,
      ],
      [
        "assistant",
        "The staging access check failed: the environment returned HTTP 403. An operator needs to restore access before I can retry.",
        baseTime - 5 * 60_000,
      ],
    ),
    [keys.handoff]: history(
      [
        "user",
        "Prepare the support handoff notes covering the launch checklist and known limitations.",
        baseTime - 40 * 60_000,
      ],
      [
        "assistant",
        "The support handoff notes are complete, including escalation contacts and known limitations. The operator has reviewed and published them.",
        baseTime - 30 * 60_000,
      ],
    ),
    [keys.onboarding]: {
      ...history(
        [
          "user",
          "Validate the onboarding flow, including account setup and the first successful task.",
          baseTime - 8 * 60_000,
        ],
        [
          "assistant",
          "Account setup is working. I am checking the first-task flow and its empty and error states.",
          baseTime - 60_000,
        ],
      ),
      inFlightRun: {
        runId: "workboard-onboarding-run",
        text: "Checking first-task navigation and recovery after a validation error…",
        startedAt: baseTime - 8 * 60_000,
        events: [],
      },
    },
    [keys.accessibility]: history(
      [
        "user",
        "Review keyboard navigation, focus visibility, and form labels in the onboarding flow.",
        baseTime - 20 * 60_000,
      ],
      [
        "assistant",
        "The accessibility review is complete. Keyboard navigation, visible focus, and form labels are ready for operator review.",
        baseTime - 3 * 60_000,
      ],
    ),
  };
}
