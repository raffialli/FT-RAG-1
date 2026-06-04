/**
 * Small post-generation answer polish rules for client-facing wording.
 *
 * This file stays dependency-free so deterministic tests can import it without
 * loading the LLM or embedding stack.
 */

export function isClimatePolicyQuery(query: string): boolean {
  return (
    /\bclimate\b/i.test(query) &&
    /\b(policy|policies|adaptation|risk management|resilience|planning|governance)\b/i.test(query)
  );
}

export function climatePolicyInstruction(query: string): string {
  if (!isClimatePolicyQuery(query)) return "";
  return "\n- For climate-policy questions, use careful attribution: say climate change shapes flood-risk context, uncertainty, and adaptation/resilience planning when supported. Say major flood events can catalyze policy change when supported. Do not state or imply that a specific event was caused by climate change unless the evidence explicitly says so.";
}

export function applyClimatePolicyCaution(query: string, answer: string): string {
  if (!isClimatePolicyQuery(query)) return answer;

  return answer
    .replace(
      /\b(Significant|Major|Extreme) flood events linked to climate change, such as ([^,.]+),/gi,
      "$1 flood events such as $2,"
    )
    .replace(
      /\b(flood events|events) linked to climate change, such as ([^,.]+),/gi,
      "$1 such as $2,"
    )
    .replace(/\bclimate change[- ]driven floods?\b/gi, "climate-related flood-risk pressures")
    .replace(/\bflood events caused by climate change\b/gi, "flood events in a changing climate context")
    .replace(
      /\b(Superstorm Sandy|Hurricane Sandy) was (caused|driven) by climate change\b/gi,
      "$1 catalyzed adaptation and resilience policy discussions"
    );
}
