import { parseResult, type Evaluation, type EvaluationInput } from "./schema.js";

// Ollama's /v1/systemone requires nonempty instructions where Kev accepts null. The
// decision contract makes them optional, so a name-routed server gets the judgment the
// criteria already express, stated neutrally per question type.
const DEFAULT_INSTRUCTIONS = {
  choice: "Select the option that best matches the state.",
  score: "Select the level that best matches the state.",
  noul: "Decide whether the true description applies to the state.",
} as const;

export function localInput(
  input: EvaluationInput,
  options: { requireInstructions?: boolean } = {},
): EvaluationInput {
  const questions: EvaluationInput["questions"] = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const instructions =
      question.instructions ??
      (options.requireInstructions ? DEFAULT_INSTRUCTIONS[question.type] : null);
    if (question.type === "score") {
      questions[id] = {
        ...question,
        instructions,
        // Send explicit text so the returned legend can be verified without reproducing Kev's renderer.
        criteria: question.criteria.map((level) =>
          typeof level === "string" ? level : level === null ? "" : JSON.stringify(level),
        ),
      };
    } else {
      questions[id] = { ...question, instructions };
    }
  }
  return { ...input, questions };
}

export function parseLocalResult(
  value: unknown,
  wireInput: EvaluationInput,
  originalInput: EvaluationInput,
): Evaluation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid local System One response.");
  }
  let result = value;
  if ("latency_ms" in value) {
    const { latency_ms, ...payload } = value;
    if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) {
      throw new Error("Invalid local System One latency metadata.");
    }
    result = payload;
  }
  const evaluation = parseResult(result, wireInput);
  for (const [id, question] of Object.entries(originalInput.questions)) {
    const answer = evaluation.answers[id];
    if (question.type === "score" && answer?.type === "score") {
      answer.legend = Object.fromEntries(
        question.criteria.map((level, index) => [String(index), level]),
      );
    }
  }
  return evaluation;
}
