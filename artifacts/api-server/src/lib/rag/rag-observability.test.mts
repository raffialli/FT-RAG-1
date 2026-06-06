import { buildQueryTrace, classifyTraceFailure, hashText, summarizeChunk, type RagTrace } from "./rag-trace.ts";
import { evaluateTraceAgainstCase } from "./rag-eval.ts";
import type { RetrievedChunk } from "./types.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, extra?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${extra ? `\n    ${extra}` : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n-- ${title} ${"-".repeat(40)}`);
}

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "doc__chunk_0001",
    documentId: "doc",
    sourceFile: "synthetic.pdf",
    pageStart: 1,
    pageEnd: 1,
    sectionPath: "Abstract",
    text: "Pazarcik Mw 7.7 and Elbistan Mw 7.6 are title and abstract facts.",
    cleaningFlags: [],
    qualityNotes: [],
    score: 0.31,
    vectorScore: 0.7,
    bm25Score: 12,
    rerankScore: 0.2,
    noiseScore: 0,
    noiseCategory: "useful-content",
    retrievalMethod: "hybrid-rrf",
    ...overrides,
  };
}

function trace(overrides: Partial<RagTrace> = {}): RagTrace {
  return {
    traceId: "trace-1",
    timestamp: "2026-06-06T00:00:00.000Z",
    app: { version: "v-test", branch: "fix/rag", commit: "abc123", nodeEnv: "test" },
    request: {
      requestId: "req-1",
      query: "What were the earthquakes?",
      normalizedQuery: "what were the earthquakes?",
      expandedTerms: ["earthquake"],
      topK: 5,
      includeEvidence: true,
      includeDebug: true,
    },
    corpus: {
      documentCount: 1,
      manifestChunkCount: 1,
      vectorCount: 1,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      scope: "active-manifest",
    },
    config: {
      retrieval: {},
      generation: { provider: "openai", model: "gpt-4.1-mini", promptMaxExcerptChars: 1400 },
      tracing: { enabled: true, persisted: false, fullText: false },
    },
    retrieval: {
      bm25Candidates: [{ chunkId: "doc__chunk_0001" }],
      vectorCandidates: [],
      fusedCandidates: [{ chunkId: "doc__chunk_0001" }],
      rerankedCandidates: [{ chunkId: "doc__chunk_0001" }],
      finalChunks: [{ chunkId: "doc__chunk_0001" }],
    },
    answer: {
      modelProvider: "openai",
      model: "gpt-4.1-mini",
      promptChars: 500,
      evidenceBlockChars: 300,
      selectedExcerpts: [{
        citationIndex: 1,
        chunkId: "doc__chunk_0001",
        sourceFile: "synthetic.pdf",
        pageStart: 1,
        pageEnd: 1,
        sectionPath: "Abstract",
        excerptChars: 120,
        excerptHash: hashText("Pazarcik Mw 7.7 and Elbistan Mw 7.6"),
        excerptPreview: "Pazarcik Mw 7.7 and Elbistan Mw 7.6",
      }],
      answerChars: 80,
      answerPreview: "The two events were Pazarcik Mw 7.7 and Elbistan Mw 7.6 [1].",
      refusal: false,
      confidence: "medium",
      confidenceReason: "Synthetic trace.",
      evidenceSufficiency: "partial",
      citationValidation: {
        citedNumbers: [1],
        validCitations: [1],
        invalidCitations: [],
        uncitedChunkIndices: [],
        noisyCitedChunks: [],
        allValid: true,
        warnings: [],
      },
      warnings: [],
    },
    latencyMs: { total: 100 },
    failure: { layer: "none", reasons: [] },
    errors: [],
    warnings: [],
    ...overrides,
  };
}

section("query trace normalization");
{
  const q = buildQueryTrace("Pazarcık Mw 7.7 and Elbistan");
  assert("normalizes Turkish diacritics", q.normalizedQuery.includes("pazarcik"));
  assert("captures expanded query terms", q.expandedTerms.includes("mw") && q.expandedTerms.includes("7.7"));
}

section("chunk trace sanitization");
{
  const c = chunk();
  const summary = summarizeChunk(c);
  assert("summary includes hash", typeof summary.textHash === "string" && summary.textHash.length === 64);
  assert("summary omits full text by default", !("text" in summary));
  assert("summary can include full text in explicit mode", summarizeChunk(c, { includeFullText: true }).text === c.text);
}

section("failure classification");
{
  assert("no candidates maps to search failure",
    classifyTraceFailure({ retrievedChunks: [], retrievalDebug: { vectorCandidates: 0, bm25Candidates: 0 } }).layer === "bm25/search");
  assert("candidate drop maps to rerank failure",
    classifyTraceFailure({ retrievedChunks: [], retrievalDebug: { vectorCandidates: 3, bm25Candidates: 2 } }).layer === "fusion/rerank");
  assert("refusal with evidence maps to generation failure",
    classifyTraceFailure({
      retrievedChunks: [chunk()],
      answer: { ...trace().answer!, refusal: true },
    }).layer === "generation");
}

section("eval classifier");
{
  const good = evaluateTraceAgainstCase({
    id: "earthquake",
    question: "What were the earthquakes?",
    expectedFacts: ["Pazarcik Mw 7.7", "Elbistan Mw 7.6"],
    expectedChunkIds: ["doc__chunk_0001"],
    requiredCitationSupport: true,
    minConfidence: "medium",
  }, trace());
  assert("passing case has no failure layer", good.passed && good.failureLayer === "none");

  const generationMiss = evaluateTraceAgainstCase({
    id: "missing-fact",
    question: "What were the earthquakes?",
    expectedFacts: ["Kahramanmaras"],
    expectedChunkIds: ["doc__chunk_0001"],
  }, trace());
  assert("missing answer fact maps to generation omission",
    !generationMiss.passed && generationMiss.failureLayer === "generation omission");

  const rerankDrop = evaluateTraceAgainstCase({
    id: "rerank-drop",
    question: "What were the earthquakes?",
    expectedChunkIds: ["doc__chunk_0002"],
  }, trace({
    retrieval: {
      bm25Candidates: [{ chunkId: "doc__chunk_0002" }],
      finalChunks: [{ chunkId: "doc__chunk_0001" }],
    },
  }));
  assert("retrieved but unselected expected chunk maps to rerank drop",
    !rerankDrop.passed && rerankDrop.failureLayer === "rerank drop");

  const negative = evaluateTraceAgainstCase({
    id: "negative",
    question: "What does corpus say about satellites?",
    negative: true,
  }, trace({ answer: { ...trace().answer!, refusal: true, confidence: "low", evidenceSufficiency: "insufficient" } }));
  assert("negative refusal passes", negative.passed);
}

console.log(`\n${"-".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAIL - ${failed} test(s) did not pass.`);
  process.exit(1);
}
console.log(`\nPASS - all ${passed} tests passed.`);
