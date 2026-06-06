import {
  buildLangSmithRunPayload,
  exportTraceToLangSmith,
  getLangSmithExportConfig,
} from "./langsmith-export.ts";
import type { RagTrace } from "./rag-trace.ts";

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

function trace(): RagTrace {
  return {
    traceId: "rag-test-trace",
    timestamp: "2026-06-06T12:00:00.000Z",
    app: { version: "0.0.0", branch: "fix/rag", commit: "abc123", nodeEnv: "test" },
    request: {
      requestId: "req-1",
      query: "What were the earthquakes?",
      normalizedQuery: "what were the earthquakes?",
      expandedTerms: ["earthquake", "mw", "7.7"],
      topK: 5,
      includeEvidence: true,
      includeDebug: false,
    },
    corpus: {
      documentCount: 1,
      manifestChunkCount: 2,
      vectorCount: 2,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      scope: "candidate-runtime-corpus",
    },
    config: {
      retrieval: { fusion: "rrf" },
      generation: { provider: "openai", model: "gpt-4.1-mini", promptMaxExcerptChars: 1400 },
      tracing: { enabled: true, persisted: false, fullText: false },
    },
    retrieval: {
      vectorCandidates: [{
        rank: 1,
        chunkId: "doc__chunk_0001",
        documentId: "doc",
        sourceFile: "synthetic.pdf",
        pageStart: 1,
        pageEnd: 1,
        sectionPath: "Abstract",
        score: 0.91,
        vectorScore: 0.91,
        bm25Score: 0,
        rerankScore: 0.5,
        noiseScore: 0,
        noiseCategory: "useful-content",
        textHash: "hash",
        textPreview: "PRIVATE EXCERPT PREVIEW",
        text: "PRIVATE FULL DOCUMENT TEXT",
      }],
      finalChunks: [{
        rank: 1,
        chunkId: "doc__chunk_0001",
        documentId: "doc",
        sourceFile: "synthetic.pdf",
        pageStart: 1,
        pageEnd: 1,
        sectionPath: "Abstract",
        score: 0.91,
        textHash: "hash",
        textPreview: "PRIVATE FINAL PREVIEW",
        text: "PRIVATE FINAL TEXT",
      }],
    },
    answer: {
      modelProvider: "openai",
      model: "gpt-4.1-mini",
      promptChars: 400,
      evidenceBlockChars: 250,
      selectedExcerpts: [{
        citationIndex: 1,
        chunkId: "doc__chunk_0001",
        sourceFile: "synthetic.pdf",
        pageStart: 1,
        pageEnd: 1,
        sectionPath: "Abstract",
        excerptChars: 50,
        excerptHash: "excerpt-hash",
        excerptPreview: "PRIVATE SELECTED EXCERPT",
        excerpt: "PRIVATE SELECTED FULL TEXT",
      }],
      answerChars: 70,
      answerPreview: "The answer cites public citation surface [1].",
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
    latencyMs: { retrieval: 10, generation: 20, total: 30 },
    failure: { layer: "none", reasons: [] },
    errors: [],
    warnings: [],
  };
}

section("disabled by default");
{
  const config = getLangSmithExportConfig({});
  assert("exporter is disabled when env flags are absent", !config.enabled);
  assert("missing env list is explicit", config.missing.includes("LANGSMITH_API_KEY"));
}

section("payload privacy");
{
  const payload = buildLangSmithRunPayload(trace(), {
    config: {
      enabled: true,
      endpoint: "https://api.smith.langchain.com",
      project: "falcontrust-rag-candidate",
      workspaceId: null,
      includeText: false,
      timeoutMs: 2500,
      missing: [],
    },
  });
  const body = JSON.stringify(payload);
  assert("question remains in inputs", body.includes("What were the earthquakes?"));
  assert("full document text is omitted by default", !body.includes("PRIVATE FULL DOCUMENT TEXT"));
  assert("retrieval text previews are omitted by default", !body.includes("PRIVATE EXCERPT PREVIEW"));
  assert("selected excerpt previews are omitted by default", !body.includes("PRIVATE SELECTED EXCERPT"));
  assert("answer preview is preserved", body.includes("public citation surface"));
}

section("text opt-in");
{
  const payload = buildLangSmithRunPayload(trace(), {
    config: {
      enabled: true,
      endpoint: "https://api.smith.langchain.com",
      project: "falcontrust-rag-candidate",
      workspaceId: null,
      includeText: true,
      timeoutMs: 2500,
      missing: [],
    },
  });
  const body = JSON.stringify(payload);
  assert("retrieval text preview is included only with opt-in", body.includes("PRIVATE EXCERPT PREVIEW"));
  assert("selected excerpt preview is included only with opt-in", body.includes("PRIVATE SELECTED EXCERPT"));
}

section("failure containment");
{
  const result = await exportTraceToLangSmith(trace(), {
    config: {
      enabled: true,
      endpoint: "https://api.smith.langchain.com",
      project: "falcontrust-rag-candidate",
      workspaceId: null,
      includeText: false,
      timeoutMs: 2500,
      missing: [],
    },
    env: { LANGSMITH_API_KEY: "SECRET_TEST_KEY" },
    fetchImpl: async (_url, init) => {
      const body = String(init?.body ?? "");
      assert("API key is not serialized into request body", !body.includes("SECRET_TEST_KEY"));
      return { ok: false, status: 500 } as Response;
    },
  });
  assert("failed export returns a non-throwing failure result",
    result.attempted && !result.success && result.httpStatus === 500);
}

console.log(`\n${"-".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAIL - ${failed} test(s) did not pass.`);
  process.exit(1);
}
console.log(`\nPASS - all ${passed} tests passed.`);
