import type { RagTrace } from "./rag-trace.js";

export type EvalFailureLayer =
  | "extraction/chunk unavailable"
  | "retrieval miss"
  | "rerank drop"
  | "prompt omission"
  | "generation omission"
  | "citation unsupported"
  | "confidence mismatch"
  | "diagnostic/search issue"
  | "none";

export interface RagEvalCase {
  id: string;
  question: string;
  expectedFacts?: string[];
  expectedChunkIds?: string[];
  expectedSourceFiles?: string[];
  negative?: boolean;
  requiredCitationSupport?: boolean;
  minConfidence?: "high" | "medium" | "low" | "insufficient";
  tags?: string[];
}

export interface RagEvalResult {
  id: string;
  passed: boolean;
  failureLayer: EvalFailureLayer;
  reasons: string[];
}

const CONFIDENCE_RANK = new Map([
  ["insufficient", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
]);

export function evaluateTraceAgainstCase(testCase: RagEvalCase, trace: RagTrace): RagEvalResult {
  const reasons: string[] = [];
  const finalChunks = finalChunkIds(trace);
  const candidateIds = candidateChunkIds(trace);
  const promptChunkIds = new Set(trace.answer?.selectedExcerpts.map((e) => e.chunkId) ?? []);
  const answerText = normalize(trace.answer?.answerPreview ?? "");

  if (testCase.negative) {
    const refused = trace.answer?.refusal || trace.answer?.evidenceSufficiency === "insufficient";
    if (!refused) reasons.push("Negative case did not refuse or mark evidence insufficient.");
    if (trace.answer && trace.answer.confidence !== "low" && trace.answer.confidence !== "insufficient") {
      reasons.push(`Negative case confidence was ${trace.answer.confidence}.`);
    }
    return finish(testCase.id, reasons, reasons.length ? "confidence mismatch" : "none");
  }

  for (const chunkId of testCase.expectedChunkIds ?? []) {
    if (!candidateIds.has(chunkId)) {
      reasons.push(`Expected chunk ${chunkId} was not present in retrieval candidates.`);
      return finish(testCase.id, reasons, "retrieval miss");
    }
    if (!finalChunks.has(chunkId)) {
      reasons.push(`Expected chunk ${chunkId} was retrieved but not selected after rerank/final selection.`);
      return finish(testCase.id, reasons, "rerank drop");
    }
    if (!promptChunkIds.has(chunkId)) {
      reasons.push(`Expected chunk ${chunkId} was final-selected but omitted from prompt excerpts.`);
      return finish(testCase.id, reasons, "prompt omission");
    }
  }

  for (const sourceFile of testCase.expectedSourceFiles ?? []) {
    const inFinal = finalChunkSummaries(trace).some((chunk) => chunk.sourceFile?.includes(sourceFile));
    const inPrompt = trace.answer?.selectedExcerpts.some((e) => e.sourceFile.includes(sourceFile));
    if (!inFinal && !inPrompt) {
      reasons.push(`Expected source ${sourceFile} was not represented in final chunks or prompt excerpts.`);
      return finish(testCase.id, reasons, "retrieval miss");
    }
  }

  for (const fact of testCase.expectedFacts ?? []) {
    if (!answerText.includes(normalize(fact))) {
      reasons.push(`Expected fact missing from answer preview: ${fact}`);
      return finish(testCase.id, reasons, "generation omission");
    }
  }

  if (testCase.requiredCitationSupport && trace.answer && !trace.answer.citationValidation.allValid) {
    reasons.push("Citation validation was not all-valid.");
    return finish(testCase.id, reasons, "citation unsupported");
  }

  if (testCase.minConfidence && trace.answer) {
    const actual = CONFIDENCE_RANK.get(trace.answer.confidence) ?? 0;
    const required = CONFIDENCE_RANK.get(testCase.minConfidence) ?? 0;
    if (actual < required) {
      reasons.push(`Confidence ${trace.answer.confidence} was below required ${testCase.minConfidence}.`);
      return finish(testCase.id, reasons, "confidence mismatch");
    }
  }

  return finish(testCase.id, reasons, "none");
}

function finalChunkIds(trace: RagTrace): Set<string> {
  return new Set(finalChunkSummaries(trace).map((c) => c.chunkId).filter((id): id is string => typeof id === "string"));
}

function candidateChunkIds(trace: RagTrace): Set<string> {
  const keys = ["bm25Candidates", "vectorCandidates", "exactRescueCandidates", "conceptRescueCandidates", "attributeRescueCandidates", "fusedCandidates", "rerankedCandidates", "finalChunks"];
  const ids = new Set<string>();
  for (const key of keys) {
    const candidates = trace.retrieval[key] as Array<{ chunkId?: string }> | undefined;
    for (const candidate of candidates ?? []) {
      if (candidate.chunkId) ids.add(candidate.chunkId);
    }
  }
  return ids;
}

function finalChunkSummaries(trace: RagTrace): Array<{ chunkId?: string; sourceFile?: string }> {
  return (trace.retrieval.finalChunks ?? trace.retrieval.selectedChunks ?? []) as Array<{
    chunkId?: string;
    sourceFile?: string;
  }>;
}

function finish(id: string, reasons: string[], failureLayer: EvalFailureLayer): RagEvalResult {
  return {
    id,
    passed: reasons.length === 0,
    failureLayer,
    reasons,
  };
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase();
}
