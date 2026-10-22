/** Eight weeks of node ticket trust KPIs for the Product Operations board. */
export function buildWorkboardTrustFixture(boardId: string, baseTime: number) {
  const week = 7 * 24 * 60 * 60 * 1000;
  const monday =
    Math.floor((baseTime + 3 * 24 * 60 * 60 * 1000) / week) * week - 3 * 24 * 60 * 60 * 1000;
  const accepted = [1, 2, 2, 3, 2, 4, 3, 3];
  const autonomous = [0, 1, 1, 2, 1, 3, 3, 2];
  const counts = (tickets: number, acceptedCount: number, clean: number, breaches = 0) => ({
    tickets,
    accepted: acceptedCount,
    cleanAccepted: clean,
    firstPass: clean + 1,
    blocked: tickets - clean - 1,
    reworkRounds: acceptedCount - clean,
    outsideCommits: 1,
    questionRounds: 0,
    operatorAnswers: 0,
    attempts: tickets + 2,
    verdictRounds: 0,
    verdictAgreedRounds: 0,
    verdictCards: 0,
    verdictAgreedCards: 0,
    verdictMissed: 0,
    contextMeasured: tickets + 2,
    smartZoneBreaches: breaches,
  });
  return {
    boardId,
    generatedAt: baseTime,
    smartZoneTokens: 150_000,
    total: counts(24, 20, 13, 3),
    classes: [
      { taskClass: "dead-code", ...counts(6, 6, 5) },
      { taskClass: "docs", ...counts(11, 9, 7, 1) },
      { taskClass: "ios-ui", ...counts(7, 5, 1, 2) },
    ],
    weeks: accepted.map((count, index) => ({
      weekStart: monday - (7 - index) * week,
      accepted: count,
      autonomous: autonomous[index] ?? 0,
      medianLeadTimeMs: (6 - index * 0.5) * 60 * 60 * 1000,
      // Review wait and context were recorded from the fourth week on.
      ...(index < 3
        ? {}
        : {
            medianReviewWaitMs: (3 - index * 0.25) * 60 * 60 * 1000,
            medianContextTokens: 90_000 + index * 8_000,
          }),
    })),
  };
}
