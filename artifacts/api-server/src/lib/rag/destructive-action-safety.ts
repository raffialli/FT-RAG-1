export function isCandidateIndexResetAllowed(input: {
  env?: NodeJS.ProcessEnv;
  confirmation?: string | null;
}): boolean {
  const env = input.env ?? process.env;
  return env.RAG_ALLOW_DESTRUCTIVE_RESET === "true" && input.confirmation === "RESET";
}
