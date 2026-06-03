/**
 * Deterministic regression tests for scoring.ts functions.
 *
 * These tests do NOT call the LLM. They test parseCitationNumbers,
 * validateCitations, assessEvidenceSufficiency, and assessConfidence
 * directly with controlled answer text and mock chunks.
 *
 * Run: pnpm --filter @workspace/api-server run test
 */

// Import using .ts extension so node --experimental-strip-types can resolve it
// without bundling the embeddings/LLM stack that answer-gen.ts depends on.
import {
  parseCitationNumbers,
  validateCitations,
  assessEvidenceSufficiency,
  assessConfidence,
  isSeverelyHedged,
  isMildlyHedged,
  SCORE_DIRECT,
  SCORE_PARTIAL,
} from "./scoring.ts";
import type { RetrievedChunk } from "./types.ts";

// ── Test harness ──────────────────────────────────────────────────────────────

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

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `actual=${JSON.stringify(actual)}  expected=${JSON.stringify(expected)}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────────`);
}

// ── Mock chunk factory ────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RetrievedChunk> & { score: number }): RetrievedChunk {
  return {
    chunkId: "test-chunk",
    documentId: "test-doc",
    sourceFile: overrides.sourceFile ?? "doc-a.pdf",
    pageStart: overrides.pageStart ?? 1,
    pageEnd: overrides.pageEnd ?? 1,
    sectionPath: overrides.sectionPath !== undefined ? overrides.sectionPath : "Results",
    text: overrides.text ?? "Sample evidence text relevant to the query.",
    cleaningFlags: overrides.cleaningFlags ?? [],
    qualityNotes: overrides.qualityNotes ?? [],
    score: overrides.score,
    vectorScore: overrides.vectorScore ?? overrides.score,
    bm25Score: overrides.bm25Score ?? 0,
    rerankScore: overrides.rerankScore ?? 0,
    noiseScore: overrides.noiseScore ?? 0.0,
    noiseCategory: overrides.noiseCategory ?? "clean",
    retrievalMethod: overrides.retrievalMethod ?? "hybrid",
  };
}

function directChunk(sourceFile = "doc-a.pdf", sectionPath: string | null = "Results"): RetrievedChunk {
  return makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile, sectionPath });
}

function partialChunk(sourceFile = "doc-a.pdf"): RetrievedChunk {
  return makeChunk({ score: SCORE_PARTIAL + 0.02, sourceFile, sectionPath: null });
}

function weakChunk(sourceFile = "doc-a.pdf"): RetrievedChunk {
  return makeChunk({ score: SCORE_PARTIAL - 0.01, sourceFile, sectionPath: null });
}

function noisyChunk(sourceFile = "doc-a.pdf"): RetrievedChunk {
  return makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile, noiseScore: 0.8, noiseCategory: "reference_list" });
}

// ── 1. parseCitationNumbers ───────────────────────────────────────────────────

section("parseCitationNumbers — comma citation parsing (Fix 1)");

assertEqual("single [1]",           parseCitationNumbers("Answer [1]"),              [1]);
assertEqual("[1,2] compact",        parseCitationNumbers("Answer [1,2]"),            [1, 2]);
assertEqual("[1, 2] spaced",        parseCitationNumbers("Answer [1, 2]"),           [1, 2]);
assertEqual("[1,2,3] triple",       parseCitationNumbers("Answer [1,2,3]"),          [1, 2, 3]);
assertEqual("[1] [2] separate",     parseCitationNumbers("Answer [1] and [2]"),      [1, 2]);
assertEqual("dedup [1][1]",         parseCitationNumbers("See [1] and [1] again"),   [1]);
assertEqual("no citations",         parseCitationNumbers("No evidence cited here."), []);
assertEqual("[5,2] sorted asc",     parseCitationNumbers("See [5,2] here"),          [2, 5]);
assertEqual("[1,2] and [3] merged", parseCitationNumbers("Text [1,2] text [3]"),    [1, 2, 3]);

// ── 2. validateCitations ─────────────────────────────────────────────────────

section("validateCitations — comma citations and edge cases");

const fiveClean = [
  directChunk("doc-a.pdf"),
  directChunk("doc-b.pdf"),
  directChunk("doc-c.pdf"),
  partialChunk("doc-d.pdf"),
  partialChunk("doc-e.pdf"),
];

{
  const cv = validateCitations("Relevant evidence [1,2] supports this.", fiveClean);
  assertEqual("comma [1,2] citedNumbers",     cv.citedNumbers,    [1, 2]);
  assertEqual("comma [1,2] validCitations",   cv.validCitations,  [1, 2]);
  assertEqual("comma [1,2] invalidCitations", cv.invalidCitations, []);
  assert("comma [1,2] allValid",              cv.allValid);
}

{
  const cv = validateCitations("Source [1, 3] and also [5].", fiveClean);
  assertEqual("[1, 3, 5] valid",  cv.validCitations,   [1, 3, 5]);
  assertEqual("no invalids",      cv.invalidCitations, []);
  assert("allValid",              cv.allValid);
}

{
  const cv = validateCitations("See [1,2,6] for details.", fiveClean);
  assertEqual("[6] is invalid",              cv.invalidCitations, [6]);
  assert("allValid=false for out-of-range",  !cv.allValid);
}

{
  const chunksWithNoisy = [...fiveClean.slice(0, 4), noisyChunk("doc-e.pdf")];
  const cv = validateCitations("Evidence [1,5] shows this.", chunksWithNoisy);
  assertEqual("noisy chunk [5]",          cv.noisyCitedChunks, [5]);
  assert("allValid=false for noisy",      !cv.allValid);
}

{
  const cv = validateCitations("No references in this response at all, the answer is fully unsupported by sources.", fiveClean);
  assertEqual("no citations → citedNumbers=[]", cv.citedNumbers, []);
  assert("no citations → allValid=false",  !cv.allValid);
  assert("no citations → warning emitted", cv.warnings.some((w) => w.includes("no source citations")));
}

{
  // Mixed valid and invalid
  const cv = validateCitations("See [1,2,3,99].", fiveClean);
  assertEqual("valid [1,2,3]",     cv.validCitations,   [1, 2, 3]);
  assertEqual("invalid [99]",      cv.invalidCitations, [99]);
  assert("allValid=false (mixed)", !cv.allValid);
}

// ── 3. assessEvidenceSufficiency ─────────────────────────────────────────────

section("assessEvidenceSufficiency");

const normalAnswer = "The evidence shows relevant flood risk information [1][2][3].";

{
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf")];
  assertEqual("sufficient (3 direct, 3 sources)",
    assessEvidenceSufficiency(chunks, normalAnswer), "sufficient");
}

{
  // 3 direct but single source, only 1 HQ section → partial (needs ≥2 HQ)
  const chunks = [
    directChunk("a.pdf", "Results"),
    directChunk("a.pdf", null),
    directChunk("a.pdf", null),
  ];
  assertEqual("partial (3 direct, 1 source, 1 HQ)",
    assessEvidenceSufficiency(chunks, normalAnswer), "partial");
}

{
  // 3 direct, single source, 2 HQ sections → partial
  const chunks = [
    directChunk("a.pdf", "Results"),
    directChunk("a.pdf", "Discussion"),
    directChunk("a.pdf", null),
  ];
  assertEqual("partial (3 direct, 1 source, 2 HQ)",
    assessEvidenceSufficiency(chunks, normalAnswer), "partial");
}

{
  // 2 direct chunks → partial
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), weakChunk("c.pdf")];
  assertEqual("partial (2 direct chunks)",
    assessEvidenceSufficiency(chunks, normalAnswer), "partial");
}

{
  // 1 direct → weak
  const chunks = [directChunk("a.pdf"), weakChunk("b.pdf"), weakChunk("c.pdf")];
  assertEqual("weak (1 direct chunk)",
    assessEvidenceSufficiency(chunks, normalAnswer), "weak");
}

{
  // Severely hedged → insufficient even with direct chunks
  const hedged = "The corpus does not contain sufficient information to answer this question.";
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf")];
  assertEqual("insufficient (severely hedged)",
    assessEvidenceSufficiency(chunks, hedged), "insufficient");
}

{
  assertEqual("insufficient (no chunks)",
    assessEvidenceSufficiency([], normalAnswer), "insufficient");
}

// ── 4. Hedging detectors ──────────────────────────────────────────────────────

section("isSeverelyHedged / isMildlyHedged");

assert("'no specific information'",             isSeverelyHedged("There is no specific information about this."));
assert("'does not contain sufficient info'",    isSeverelyHedged("The evidence does not contain sufficient information."));
assert("'corpus does not contain'",             isSeverelyHedged("The corpus does not contain relevant data."));
assert("'cannot find'",                         isSeverelyHedged("I cannot find this in the documents."));
assert("'not enough information'",              isSeverelyHedged("There is not enough information available."));
assert("case-insensitive severe",               isSeverelyHedged("NO SPECIFIC INFORMATION was found."));
assert("non-hedged not severe",                !isSeverelyHedged("Flood risk is primarily driven by [1][2]."));

assert("'limited direct information'",          isMildlyHedged("There is limited direct information on this."));
assert("'not explicitly addressed'",            isMildlyHedged("This is not explicitly addressed in the sources."));
assert("'partially supported'",                 isMildlyHedged("The claim is partially supported by evidence."));
assert("non-hedged not mild",                  !isMildlyHedged("Flood risk factors include storm surge [1] and sea level [2]."));
// New mild-hedge patterns (Client QA Fixes)
assert("'only indirectly'",                     isMildlyHedged("The corpus only indirectly addresses this topic."));
assert("'indirectly supported'",                isMildlyHedged("The conclusion is only indirectly supported by [1]."));
assert("'does not fully answer'",               isMildlyHedged("The evidence does not fully answer this question."));
assert("'not fully supported'",                 isMildlyHedged("This claim is not fully supported by the evidence."));
assert("'not well supported'",                  isMildlyHedged("The assertion is not well supported by available sources."));
assert("'cannot definitively'",                 isMildlyHedged("We cannot definitively answer based on these sources."));
assert("'only partially addressed'",            isMildlyHedged("The query is only partially addressed by the corpus."));
assert("'only partially covered'",              isMildlyHedged("This topic is only partially covered in the documents."));

// ── 5. assessConfidence — sufficiency cap policy (Fix 2) ─────────────────────

section("assessConfidence — evidence sufficiency caps confidence");

const fullCitedAnswer = "Flood risk is driven by several factors [1][2][3][4][5].";
const sufficientChunks = [
  directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf"),
  partialChunk("d.pdf"), partialChunk("e.pdf"),
];

{
  // sufficient → high allowed
  const suf = assessEvidenceSufficiency(sufficientChunks, fullCitedAnswer);
  const cv = validateCitations(fullCitedAnswer, sufficientChunks);
  const conf = assessConfidence("", sufficientChunks, fullCitedAnswer, cv, suf);
  assertEqual("sufficient evidence → high allowed", conf.level, "high");
}

{
  // partial → max medium
  const chunks = [directChunk("a.pdf"), directChunk("a.pdf"), partialChunk("a.pdf")];
  const ans = "Evidence shows [1][2][3].";
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("", chunks, ans, cv, "partial");
  assert("partial → not high",             conf.level !== "high");
  assert("partial → medium or low",        conf.level === "medium" || conf.level === "low");
}

{
  // weak → max low
  const chunks = [weakChunk("a.pdf"), weakChunk("b.pdf"), weakChunk("c.pdf")];
  const ans = "Some relevant text [1].";
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("", chunks, ans, cv, "weak");
  assertEqual("weak → confidence=low", conf.level, "low");
}

{
  // insufficient → max low
  const chunks = [weakChunk("a.pdf")];
  const ans = "No specific information found.";
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("", chunks, ans, cv, "insufficient");
  assertEqual("insufficient → confidence=low", conf.level, "low");
}

{
  // partial + would-be-high-scoring chunks → capped to medium
  const chunks = [
    directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf"),
    directChunk("d.pdf"), directChunk("e.pdf"),
  ];
  const ans = "Strong multi-source evidence [1][2][3][4][5].";
  const cv = validateCitations(ans, chunks);
  // Force partial sufficiency via direct injection
  const conf = assessConfidence("", chunks, ans, cv, "partial");
  assert("partial cap: strong chunks still capped to medium", conf.level !== "high");
  assertEqual("partial cap → medium", conf.level, "medium");
  assert("partial cap reason mentions sufficiency", conf.reason.includes("partial") || conf.reason.includes("capped"));
}

// ── 6. Benchmark regression checks (Q3 / Q6 / Q7 / Q9 / Q10) ────────────────

section("Benchmark regressions — Q3/Q6/Q7/Q9/Q10 direction checks");

// Q3 South Sudan: LLM says corpus lacks strategy evidence
{
  const ans = "The corpus does not contain sufficient information to answer this question about South Sudan flood adaptation strategies. No specific information about South Sudan is available [1].";
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf"), partialChunk("d.pdf"), partialChunk("e.pdf")];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("South Sudan strategies", chunks, ans, cv, suf);
  assert("Q3 suf=insufficient (severely hedged)", suf === "insufficient");
  assert("Q3 confidence≠high", conf.level !== "high");
  assertEqual("Q3 confidence=low", conf.level, "low");
}

// Q6 EWS fatalities: no quantitative fatality data in corpus
{
  const ans = "There is no specific information about quantitative fatality rates associated with early warning systems in the provided documents [1][2].";
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), directChunk("c.pdf"), partialChunk("d.pdf"), partialChunk("e.pdf")];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("EWS fatalities", chunks, ans, cv, suf);
  assert("Q6 suf=insufficient (no specific info)", suf === "insufficient");
  assert("Q6 confidence≠high", conf.level !== "high");
}

// Q7 Climate change FRM: corpus lacks direct policy mechanism coverage
{
  const ans = "The provided evidence does not contain specific details on climate change flood risk management policy mechanisms. The corpus does not contain sufficient information on FRM policy [1].";
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), directChunk("a.pdf"), partialChunk("c.pdf"), weakChunk("d.pdf")];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("Climate change FRM", chunks, ans, cv, suf);
  assert("Q7 suf=insufficient (severely hedged)", suf === "insufficient");
  assert("Q7 confidence≠high", conf.level !== "high");
  assertEqual("Q7 confidence=low", conf.level, "low");
}

// Q9 Resilience methods: single-source + mild hedge → not high
{
  const ans = "Several resilience methods are documented [1][2]. There is limited direct information specifically assessing their effectiveness.";
  const chunks = [
    directChunk("a.pdf"), directChunk("a.pdf"),
    partialChunk("a.pdf"), partialChunk("a.pdf"), weakChunk("a.pdf"),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("Resilience methods", chunks, ans, cv, suf);
  assert("Q9 suf≠sufficient (single source)", suf !== "sufficient");
  assert("Q9 confidence≠high (single source + mild hedge)", conf.level !== "high");
}

// Q10 Social risk: single-source + mild hedging → medium or low
{
  const ans = "Social risk constructions are partially supported by evidence from the document [1][2][3][4][5]. However, there is limited direct information about social risk in this context.";
  const chunks = [
    directChunk("book.pdf"), directChunk("book.pdf"), directChunk("book.pdf", null),
    partialChunk("book.pdf"), partialChunk("book.pdf"),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("Social risk", chunks, ans, cv, suf);
  assert("Q10 suf=partial (single source)", suf === "partial");
  assert("Q10 confidence≠high", conf.level !== "high");
  assert("Q10 is medium or low", conf.level === "medium" || conf.level === "low");
}

// ── 7. Client QA fix regressions (Q3 / Q4 / Q10) ─────────────────────────────

section("Client QA Fixes — hedging-calibrated regression checks");

// Q3 Communication: indirect support should cap confidence at medium (mild hedge)
{
  const ans = "Emergency managers can communicate flood risk using several approaches [1][2]. However, the evidence only indirectly addresses public messaging strategies and does not fully cover community outreach methods.";
  const chunks = [directChunk("a.pdf"), directChunk("b.pdf"), partialChunk("c.pdf"), partialChunk("d.pdf"), weakChunk("e.pdf")];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("communicate flood risk to the public", chunks, ans, cv, suf);
  assert("Q3 comm: 'only indirectly' → mild hedge detected", isMildlyHedged(ans));
  assert("Q3 comm: confidence ≠ high (mild hedge caps to medium)", conf.level !== "high");
  assert("Q3 comm: confidence is medium or low", conf.level === "medium" || conf.level === "low");
}

// Q4 Community engagement: partial single-source evidence → not high
{
  const ans = "Community engagement plays a significant role in flood resilience through local preparedness programs [1][2][3]. The evidence does not fully answer how engagement varies by context, and this is only partially covered in the sources.";
  const chunks = [
    directChunk("a.pdf"), directChunk("a.pdf"), directChunk("a.pdf"),
    partialChunk("a.pdf"), weakChunk("a.pdf"),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("community engagement flood resilience", chunks, ans, cv, suf);
  assert("Q4: 'does not fully answer' → mild hedge detected", isMildlyHedged(ans));
  assert("Q4: suf ≤ partial (single source)", suf !== "sufficient");
  assert("Q4: confidence ≠ high", conf.level !== "high");
}

// Q10 Reference query: 'only indirectly supported' → mild hedge
{
  const refAns = "The FRM book cites a range of references. However, the retrieved evidence only indirectly supports a complete list [1][2].";
  assert("Q10 refQuery: 'only indirectly supported' → mild hedge", isMildlyHedged(refAns));
}

// Confirm new patterns don't fire for clean assertive answers
{
  const clean = "Flood risk is driven by storm surge intensity [1][2][3]. Early warning systems reduce mortality significantly [4][5].";
  assert("clean answer: new patterns don't fire severe", !isSeverelyHedged(clean));
  assert("clean answer: new patterns don't fire mild", !isMildlyHedged(clean));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAIL — ${failed} test(s) did not pass.`);
  process.exit(1);
} else {
  console.log(`\nPASS — all ${passed} tests passed.`);
}
