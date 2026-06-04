/**
 * Deterministic regression tests for scoring.ts functions.
 *
 * These tests do NOT call the LLM. They test parseCitationNumbers,
 * validateCitations, assessEvidenceSufficiency, assessConfidence,
 * querySupportLevel, isSeverelyHedged, and isMildlyHedged
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
  querySupportLevel,
  SCORE_DIRECT,
  SCORE_PARTIAL,
} from "./scoring.ts";
import { classifyChunkNoise } from "./chunk-classifier.ts";
import { buildSourceProvenanceAliases, formatPageRange } from "./source-provenance-core.ts";
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
    documentId: overrides.documentId ?? "test-doc",
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

function bibliographyChunk(sourceFile = "book.pdf"): RetrievedChunk {
  return makeChunk({
    score: SCORE_DIRECT + 0.05,
    sourceFile,
    sectionPath: "Reference",
    noiseScore: 0.83,
    noiseCategory: "bibliography",
  });
}

// ── 0. source provenance metadata ────────────────────────────────────────────

section("source provenance metadata");

{
  const chunk = makeChunk({
    score: SCORE_DIRECT + 0.05,
    documentId: "JEM_2024_Special_Issue_1780399724235_pdf",
    sourceFile: "JEM_2024_Special_Issue_1780399724235.pdf",
    pageStart: 6,
    pageEnd: 7,
    sectionPath: "Methodology",
    text: "Manufactured housing vulnerability is assessed at household, housing structure, and park community levels.",
  });
  const source = buildSourceProvenanceAliases({
    documentId: chunk.documentId,
    sourceFile: chunk.sourceFile,
    displayTitle: "JEM 2024 Special Issue",
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
  });
  assertEqual("documentId is exposed", source.documentId, "JEM_2024_Special_Issue_1780399724235_pdf");
  assertEqual("document_id alias is exposed", source.document_id, "JEM_2024_Special_Issue_1780399724235_pdf");
  assertEqual("friendly document alias is exposed", source.document, "JEM 2024 Special Issue");
  assertEqual("friendly source alias is exposed", source.source, "JEM 2024 Special Issue");
  assertEqual("rawFilename alias is preserved", source.rawFilename, "JEM_2024_Special_Issue_1780399724235.pdf");
  assertEqual("page alias is formatted", source.page, "pp. 6-7");
}

assertEqual("single page format", formatPageRange(4, 4), "p. 4");
assertEqual("missing page format", formatPageRange(0, 0), null);

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
  const chunksWithBibliography = [bibliographyChunk("frm-book.pdf"), directChunk("doc-b.pdf")];
  const normalCv = validateCitations("References include [1] and context [2].", chunksWithBibliography);
  const refCv = validateCitations("References include [1] and context [2].", chunksWithBibliography, true);
  assertEqual("normal query: bibliography citation marked noisy", normalCv.noisyCitedChunks, [1]);
  assert("normal query: bibliography allValid=false", !normalCv.allValid);
  assertEqual("reference query: bibliography citation allowed", refCv.noisyCitedChunks, []);
  assertEqual("reference query: bibliography valid citations", refCv.validCitations, [1, 2]);
  assert("reference query: bibliography allValid=true", refCv.allValid);
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

section("isSeverelyHedged / isMildlyHedged — v1 patterns");

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

// v2 mild-hedge additions (Client QA Fixes lane)
assert("'only indirectly'",                     isMildlyHedged("The corpus only indirectly addresses this topic."));
assert("'indirectly supported'",                isMildlyHedged("The conclusion is only indirectly supported by [1]."));
assert("'does not fully answer'",               isMildlyHedged("The evidence does not fully answer this question."));
assert("'not fully supported'",                 isMildlyHedged("This claim is not fully supported by the evidence."));
assert("'not well supported'",                  isMildlyHedged("The assertion is not well supported by available sources."));
assert("'cannot definitively'",                 isMildlyHedged("We cannot definitively answer based on these sources."));
assert("'only partially addressed'",            isMildlyHedged("The query is only partially addressed by the corpus."));
assert("'only partially covered'",              isMildlyHedged("This topic is only partially covered in the documents."));

section("isMildlyHedged — followup patterns (Blocker 2)");

assert("'does not directly outline'",           isMildlyHedged("The evidence does not directly outline flood communication strategies."));
assert("'does not directly explain'",           isMildlyHedged("The corpus does not directly explain how EWS reduce fatalities."));
assert("'does not directly describe'",          isMildlyHedged("The document does not directly describe this process."));
assert("'does not explicitly outline'",         isMildlyHedged("The evidence does not explicitly outline the required approach."));
assert("'does not provide a direct'",           isMildlyHedged("The sources do not provide a direct answer to this question."));
assert("'evidence does not directly'",          isMildlyHedged("The evidence does not directly support this conclusion."));
assert("'only indirectly supports'",            isMildlyHedged("The retrieved evidence only indirectly supports this claim."));
assert("'indirectly suggests'",                 isMildlyHedged("The corpus indirectly suggests some communication strategies."));
assert("'partial evidence'",                    isMildlyHedged("Only partial evidence is available for this topic."));
assert("'limited direct evidence'",             isMildlyHedged("There is limited direct evidence for early warning fatality reduction."));
assert("'indirect evidence'",                   isMildlyHedged("This is based on indirect evidence from the corpus."));
// Guard: these should NOT fire for confident answers
assert("clean confident → not mild",           !isMildlyHedged("Flood risk is driven by storm surge intensity [1][2]."));
assert("clean multi-source → not mild",        !isMildlyHedged("EWS reduce mortality through early evacuation coordination [1][2][3]."));

// ── 5. assessConfidence — sufficiency cap policy ──────────────────────────────

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
  const conf = assessConfidence("", chunks, ans, cv, "partial");
  assert("partial cap: strong chunks still capped to medium", conf.level !== "high");
  assertEqual("partial cap → medium", conf.level, "medium");
  assert("partial cap reason mentions sufficiency", conf.reason.includes("partial") || conf.reason.includes("capped"));
}

{
  const chunks = [
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "a.pdf", sectionPath: "Key Words", text: "Socioeconomic vulnerability poverty income housing mobility" }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "b.pdf", sectionPath: "Key Words", text: "Socioeconomic vulnerability poverty income housing mobility" }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "c.pdf", sectionPath: "Key Words", text: "Socioeconomic vulnerability poverty income housing mobility" }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "d.pdf", sectionPath: "Results", text: "Socioeconomic vulnerability is shaped by poverty, income, housing, and mobility constraints." }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "e.pdf", sectionPath: "Discussion", text: "Vulnerable households face socioeconomic barriers including income, housing, and recovery affordability." }),
  ];
  const ans = "Socioeconomic factors influence flood vulnerability through housing, income, and mobility constraints [1][2][3][4][5].";
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence("socioeconomic vulnerability", chunks, ans, cv, "sufficient");
  assert("low-value section dominance → not high", conf.level !== "high");
  assertEqual("low-value section dominance → medium", conf.level, "medium");
}

// ── 6. Benchmark regressions (Q3 / Q6 / Q7 / Q9 / Q10) ──────────────────────

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

// Followup Q3/Q5: indirect language from Codex audit
{
  const q3indirect = "The evidence does not directly outline specific communication strategies for emergency managers [1][2]. It indirectly suggests some approaches through discussion of public awareness campaigns.";
  assert("Q3/Q5 followup: 'does not directly outline' → mild hedge", isMildlyHedged(q3indirect));
  assert("Q3/Q5 followup: 'indirectly suggests' → mild hedge",        isMildlyHedged(q3indirect));
}

// Followup Q6: indirect EWS language
{
  const q6indirect = "The evidence does not directly explain how EWS have reduced flood fatalities [1]. It does not provide a direct count of lives saved.";
  assert("Q6 followup: 'does not directly explain' → mild hedge", isMildlyHedged(q6indirect));
  assert("Q6 followup: 'does not provide a direct' → mild hedge", isMildlyHedged(q6indirect));
}

// Confirm new patterns don't fire for clean assertive answers
{
  const clean = "Flood risk is driven by storm surge intensity [1][2][3]. Early warning systems reduce mortality significantly [4][5].";
  assert("clean answer: new patterns don't fire severe", !isSeverelyHedged(clean));
  assert("clean answer: new patterns don't fire mild", !isMildlyHedged(clean));
}

// ── 8. querySupportLevel — query-aware support level (Blocker 3) ──────────────

section("querySupportLevel — strict direct/partial/weak classification");

// Strong match: score > SCORE_DIRECT, ≥3 query content words in chunk → direct
{
  const query = "How should emergency managers communicate flood risk to the public?";
  const text = "Emergency managers communicate flood risk to the public through warning dissemination, community outreach programs, and public awareness campaigns targeting vulnerable populations.";
  assertEqual("strong match (≥3 terms) → direct",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "direct");
}

// Medium: score > SCORE_DIRECT, only 1 matching term → weak for Q3 because it
// lacks communication/public warning evidence.
{
  const query = "How should emergency managers communicate flood risk to the public?";
  const text = "Structural measures such as levees reduce flood damage in coastal areas. Emergency services coordinate response efforts.";
  assertEqual("only 1 match despite high score → weak",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "weak");
}

// Zero match: score > SCORE_DIRECT, no query terms in chunk → weak
{
  const query = "How should emergency managers communicate flood risk to the public?";
  const text = "Gabion walls are retaining structures used to control erosion and stabilize slopes near waterways.";
  assertEqual("zero match despite high score → weak",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "weak");
}

// Score-only partial: SCORE_PARTIAL < score ≤ SCORE_DIRECT → partial regardless of text
{
  assertEqual("mid-score range → partial",
    querySupportLevel("flood risk management communication", SCORE_PARTIAL + 0.01, "any content"), "partial");
}

// Weak: score ≤ SCORE_PARTIAL → weak regardless of text overlap
{
  const query = "flood risk management";
  const text = "flood risk management is a critical component of emergency planning and disaster preparedness";
  assertEqual("low score → weak even with good overlap",
    querySupportLevel(query, SCORE_PARTIAL - 0.01, text), "weak");
}

// Q3-style: communication chunk with full overlap → direct
{
  const query = "communicate flood risk public emergency managers";
  const text = "Risk communication strategies for emergency managers include public warning systems, community outreach, and educational programs targeting flood-prone areas. Public awareness is crucial.";
  assertEqual("Q3 comm chunk: full overlap → direct",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "direct");
}

// Q3-style: structural chunk, no communication terms → partial
{
  const query = "communicate flood risk public emergency managers";
  const text = "Structural mitigation through retention ponds, gabion baskets, and flow control weirs reduces peak discharge.";
  assertEqual("Q3 structural chunk: no comm terms → weak",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "weak");
}

// Q6-style: physical mitigation chunk with incidental EWS terms → partial
{
  const query = "What methods are used for flood forecasting and early warning systems?";
  const text = "The gabion wall is a physical mitigation project. Disaster risk plans also mention early warning, evacuation, and monitoring alongside structural mitigation.";
  assertEqual("Q6 physical mitigation chunk → partial",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text), "partial");
}

// Low-value sections should not be labelled direct even with text overlap
{
  const query = "How do socioeconomic factors influence flood vulnerability?";
  const text = "Socioeconomic factors, income, housing affordability, and vulnerability influence flood exposure and recovery.";
  assertEqual("Key Words section → max partial support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, text, "Key Words"), "partial");
}

// Empty query edge case
{
  assertEqual("empty query → direct (no words to check)",
    querySupportLevel("", SCORE_DIRECT + 0.05, "some chunk text here"), "direct");
}

// Hardening: direct requires answer-claim support, not broad flood/risk overlap
{
  const query = "What role does community engagement play in flood resilience?";
  const directText = "Community engagement improves flood resilience when residents participate in preparedness planning, local outreach, volunteer networks, and stakeholder collaboration.";
  const partialText = "Preparedness planning can improve flood resilience, but the passage does not describe how people are involved.";
  const weakText = "Flood hazard maps estimate peak discharge and inundation extent using rainfall-runoff models.";
  assertEqual("Q4 community engagement direct support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, directText), "direct");
  assertEqual("Q4 community engagement partial support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, partialText), "partial");
  assertEqual("Q4 community engagement tangential support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, weakText), "weak");
}

{
  const query = "How does climate change affect flood risk management policy?";
  const directText = "Climate change scenarios are incorporated into flood management planning and policy so adaptation measures account for future risk.";
  const partialText = "Climate change can increase rainfall extremes and future flood hazard, but this passage stops at hazard drivers.";
  const weakText = "Warning sirens and evacuation routes are described for current flood response operations.";
  assertEqual("Q7 climate policy direct support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, directText), "direct");
  assertEqual("Q7 climate policy partial support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, partialText), "partial");
  assertEqual("Q7 climate policy weak support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, weakText), "weak");
}

{
  const query = "How does climate change affect flood risk management policy?";
  const text = "In 2017, the Flood Control Act of Japan was amended, demanding zero evacuation delay and a Council for Large-Scale Flood Mitigation.";
  assertEqual("Q7 climate policy Japan warning-law support is partial, not direct",
    querySupportLevel(query, SCORE_DIRECT + 0.08, text), "partial");
}

{
  const query = "How does climate change affect flood risk management policy?";
  const text = "Her research centres on legal geographies. She graduated with an MSc in Water Science, Policy and Management. Earthscan Water Text.";
  assertEqual("Q7 climate policy frontmatter bio support is partial, not direct",
    querySupportLevel(query, SCORE_DIRECT + 0.08, text), "partial");
}

{
  const query = "How do socioeconomic factors influence flood vulnerability?";
  const text = "The literature supports that low-income status (poverty) is a leading variable of global vulnerability. People living in poverty are particularly vulnerable to flood and drought shocks.";
  assertEqual("Q5 socioeconomic Wood poverty source is direct support",
    querySupportLevel(query, SCORE_DIRECT + 0.08, text, "Finding"), "direct");
}

{
  const query = "What role does community engagement play in flood resilience?";
  const text = "Democratizing data collection and exchange requires a systematic outreach approach and community engagement sustained before, during, and after disaster while soliciting input from citizens and rescue operators.";
  assertEqual("Q3 community engagement JEM outreach source is direct support",
    querySupportLevel(query, SCORE_DIRECT + 0.08, text, "Discussion"), "direct");
}

{
  const query = "How should emergency managers communicate flood risk to the public?";
  const ans = "Emergency managers can communicate flood risk through public warnings and outreach [1][2]. The evidence only indirectly supports a full communication strategy.";
  const chunks = [
    makeChunk({ score: SCORE_DIRECT + 0.06, sourceFile: "a.pdf", text: "Public warning dissemination and outreach help communicate flood risk to residents before evacuation." }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "b.pdf", text: "Emergency managers use flood maps to plan operations, but the passage does not discuss public messaging." }),
    makeChunk({ score: SCORE_DIRECT + 0.04, sourceFile: "c.pdf", text: "Hydrologic models estimate inundation depth for flood scenarios." }),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans, query);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence(query, chunks, ans, cv, suf);
  assert("Q3 hardening: indirect answer not sufficient", suf !== "sufficient");
  assert("Q3 hardening: indirect answer not high confidence", conf.level !== "high");
  assertEqual("Q3 hardening: first chunk direct", querySupportLevel(query, chunks[0].score, chunks[0].text), "direct");
  assertEqual("Q3 hardening: model chunk weak", querySupportLevel(query, chunks[2].score, chunks[2].text), "weak");
}

{
  const query = "What role does community engagement play in flood resilience?";
  const ans = "Community engagement appears to support flood resilience [1], but the evidence is partial and does not fully answer how this varies by context [2][3].";
  const chunks = [
    makeChunk({ score: SCORE_DIRECT + 0.06, sourceFile: "a.pdf", text: "Community engagement, local participation, stakeholder collaboration, and preparedness outreach improve flood resilience." }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "b.pdf", text: "Preparedness planning improves resilience, but local community participation is not explicitly described." }),
    makeChunk({ score: SCORE_DIRECT + 0.04, sourceFile: "c.pdf", text: "Inundation models show where flood depths may be highest." }),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans, query);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence(query, chunks, ans, cv, suf);
  assert("Q4 hardening: mixed evidence not sufficient", suf !== "sufficient");
  assert("Q4 hardening: mixed evidence not high", conf.level !== "high");
}

{
  const query = "How does climate change affect flood risk management policy?";
  const ans = "Climate change is relevant to flood management planning [1], but the evidence only partially addresses policy mechanisms [2][3].";
  const chunks = [
    makeChunk({ score: SCORE_DIRECT + 0.06, sourceFile: "a.pdf", text: "Climate change scenarios inform flood risk management planning and adaptation policy." }),
    makeChunk({ score: SCORE_DIRECT + 0.05, sourceFile: "b.pdf", text: "Climate change may increase future rainfall extremes and flood hazard." }),
    makeChunk({ score: SCORE_DIRECT + 0.04, sourceFile: "c.pdf", text: "Flood warning systems notify residents before evacuation." }),
  ];
  const suf = assessEvidenceSufficiency(chunks, ans, query);
  const cv = validateCitations(ans, chunks);
  const conf = assessConfidence(query, chunks, ans, cv, suf);
  assert("Q7 hardening: mixed evidence not sufficient", suf !== "sufficient");
  assert("Q7 hardening: mixed evidence not high", conf.level !== "high");
}

{
  const fragment = "Smith, J. (2019) Flood risk communication. Risk Analysis. Available from: www.example.org. Accessed 2022. Government report.";
  const cls = classifyChunkNoise(fragment, null);
  assertEqual("bibliography fragment classified as bibliography", cls.category, "bibliography");
  assert("bibliography fragment hard-excludable from normal queries", cls.noiseScore >= 0.72);
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
