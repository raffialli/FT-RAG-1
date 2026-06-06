import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Search, exactPhraseSearch, matchesNormalizedSearch, normalizeForSearch, scoreNormalizedSearch, tokenize } from "./bm25.ts";
import { classifyChunkNoise } from "./chunk-classifier.ts";
import { querySupportLevel, SCORE_DIRECT } from "./scoring.ts";
import { selectRelevantExcerpt } from "./prompt-context.ts";
import { isLikelyPdfUpload, safePdfUploadFilename, uniquePdfUploadFilename } from "./upload-safety.ts";
import { isCandidateIndexResetAllowed } from "./destructive-action-safety.ts";
import type { VectorRecord } from "./types.ts";

let passed = 0;
let failed = 0;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

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

function record(id: string, text: string, sectionPath = "Abstract"): VectorRecord {
  return {
    chunkId: id,
    documentId: "doc",
    sourceFile: "client-upload.pdf",
    pageStart: 1,
    pageEnd: 1,
    sectionPath,
    text,
    cleaningFlags: [],
    embedding: [0],
  };
}

async function loadRetrieverRescues(): Promise<{
  attributeRescueSearch: (
    query: string,
    records: VectorRecord[]
  ) => Array<{ record: VectorRecord; score: number }>;
}> {
  const bundled = await build({
    entryPoints: [path.join(TEST_DIR, "retriever.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    external: ["@huggingface/transformers"],
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("Failed to bundle retriever test module.");
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const { attributeRescueSearch } = await loadRetrieverRescues();

section("search normalization");

{
  const normalized = normalizeForSearch("Pazarcık Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaraş-Türkiye");
  assert("diacritics are normalized", normalized.includes("pazarcik") && normalized.includes("kahramanmaras"));
  const tokens = tokenize("earthquakes magnitudes locations Pazarcık Mw 7.7");
  assert("plural event term stems to singular", tokens.includes("earthquake"));
  assert("magnitude expands to Mw", tokens.includes("mw"));
  assert("Mw expands to magnitude", tokens.includes("magnitude"));
  assert("decimal magnitude is preserved", tokens.includes("7.7"));
  assert("location expands to place/city cues", tokens.includes("place") && tokens.includes("city"));
}

section("BM25 numeric/title evidence retrieval");

{
  const answerChunk = record(
    "answer",
    "Geotechnical reconnaissance of the February 6, 2023, Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes. ABSTRACT On February 6, 2023, a moment magnitude of 7.7 earthquake occurred on the East Anatolian Fault Zone at Pazarcik-Kahramanmaras, Turkiye."
  );
  const contextOnlyChunk = record(
    "context",
    "After the Kahramanmaras earthquake, patients were transferred to different cities in Turkey. This study discusses preparedness, medical education, and pediatric response after the disaster.",
    "Method"
  );
  const irrelevantChunk = record(
    "irrelevant",
    "South Sudan flooding overwhelms government mitigation capacity. The study has two main queries about flood risk reduction and local emergency management.",
    "Literature Review"
  );
  const results = bm25Search(
    "What were the two main earthquakes discussed, including their magnitudes and locations?",
    [irrelevantChunk, contextOnlyChunk, answerChunk],
    3
  );
  assert("BM25 ranks answer-bearing magnitude/location chunk first", results[0]?.record.chunkId === "answer",
    `ranking=${results.map((r) => `${r.record.chunkId}:${r.score.toFixed(3)}`).join(", ")}`);
}

section("exact rescue normalization");

{
  const answerChunk = record(
    "answer",
    "Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes."
  );
  const results = exactPhraseSearch("Pazarcık earthquakes magnitudes locations", [answerChunk]);
  assert("exact/entity rescue tolerates diacritics and plural attributes", results.length === 1);
}

section("hybrid retrieval rescue candidates");

{
  const answerChunk = record(
    "answer",
    "Geotechnical reconnaissance of the February 6, 2023, Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes. ABSTRACT On February 6, 2023, the first earthquake occurred near Pazarcik and the second near Elbistan."
  );
  const contextOnlyChunk = record(
    "context",
    "The Kahramanmaras earthquake disrupted hospitals in Hatay and Antakya. The article discusses emergency response, preparedness, and patient transfers, but does not list the two main event magnitudes.",
    "Method"
  );
  const unrelatedChunk = record(
    "unrelated",
    "Flood insurance rate maps and community co-production can improve public understanding of risk.",
    "Introduction"
  );
  const results = attributeRescueSearch(
    "What were the two main earthquakes discussed, including their magnitudes and locations?",
    [contextOnlyChunk, unrelatedChunk, answerChunk]
  );
  assert("attribute rescue surfaces answer-bearing numeric/location chunk first",
    results[0]?.record.chunkId === "answer",
    `ranking=${results.map((r) => `${r.record.chunkId}:${r.score.toFixed(3)}`).join(", ")}`);
  assert("attribute rescue excludes unrelated non-event chunks",
    results.every((r) => r.record.chunkId !== "unrelated"));
}

section("prompt context extraction");

{
  const filler =
    "After the Kahramanmaras earthquake, patients were transferred to different cities in Turkey. ".repeat(24);
  const answer =
    "Geotechnical reconnaissance title: Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes. ";
  const tail = "The remaining passage discusses site effects and recovery operations. ".repeat(20);
  const excerpt = selectRelevantExcerpt(
    "What were the two main earthquakes discussed, including their magnitudes and locations?",
    `${filler}${answer}${tail}`,
    700
  );
  assert("excerpt includes answer-bearing magnitude pair", /Pazarcik Mw = 7\.7 and Elbistan Mw = 7\.6/.test(excerpt),
    excerpt);
  assert("excerpt is clipped to a bounded prompt window", excerpt.length <= 710, `length=${excerpt.length}`);
}

section("diagnostic chunk search matching");

{
  const answerText =
    "Geotechnical reconnaissance of the February 6, 2023, Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes.";
  assert("diagnostic search finds magnitude/location evidence by expanded terms",
    matchesNormalizedSearch("earthquake magnitude location", ["JEM May-June 2025.pdf", "Abstract", answerText]));
  assert("diagnostic search tolerates diacritics and plurals",
    matchesNormalizedSearch("Pazarcık earthquakes magnitudes locations", [answerText]));
  assert("diagnostic search rejects unrelated chunks",
    !matchesNormalizedSearch("earthquake magnitude location", ["South Sudan flood mitigation and community preparedness."]));
}

section("diagnostic chunk search ranking");

{
  const noisyContext =
    "Flood policy process in Jakarta 79 A revolving door of policy evolution 91 Flood insurance maps and the US National Flood Insurance Program 177.";
  const answerText =
    "Geotechnical reconnaissance of the February 6, 2023, Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes.";
  const noisyScore = scoreNormalizedSearch("earthquake magnitude location", ["Flood Risk Management.pdf", noisyContext]);
  const answerScore = scoreNormalizedSearch("earthquake magnitude location", ["JEM May-June 2025.pdf", answerText]);
  assert("diagnostic ranking scores answer-bearing numeric/entity evidence above broad event/noise matches",
    answerScore > noisyScore,
    `answerScore=${answerScore}, noisyScore=${noisyScore}`);

  const broadDisasterResponse =
    "Of pre- and post-disaster management and recovery for the Turkey and Syria earthquakes of February 2023. Fourth, embracing technology and innovation can improve disaster response operations, including satellite imaging and real-time data.";
  const unrelatedMethod =
    "First, we contacted potential interviewees by letter. Second, we made follow-up phone calls to determine interest and set times and places for interviews. Third, we conducted the interview.";
  const broadScore = scoreNormalizedSearch("earthquake magnitude location", ["JEM May-June 2025.pdf", broadDisasterResponse]);
  const methodScore = scoreNormalizedSearch("earthquake magnitude location", ["JEM interview methods", unrelatedMethod]);
  assert("diagnostic ranking prefers explicit Mw magnitude/location chunk over broad earthquake response text",
    answerScore > broadScore,
    `answerScore=${answerScore}, broadScore=${broadScore}`);
  assert("diagnostic ranking prefers explicit Mw magnitude/location chunk over unrelated ordinal/method text",
    answerScore > methodScore,
    `answerScore=${answerScore}, methodScore=${methodScore}`);
}

section("retrieval-time noise classification");

{
  const inlineIndex =
    "INDEX Flood Risk Management accountability 7-10 actor mapping 43-8 adaptation 43-57 advocacy coalition framework 79 flood insurance maps 177 local knowledge 201 vulnerability 222 warning systems 132.";
  const inlineToc =
    "POLICY AND IMPLEMENTATION 7 Flood policy process in Jakarta, Indonesia 79 A revolving door of policy evolution 91 Policy belief change and learning 103 Emergency intentional flooding 141 Flood insurance maps 177 The effect of public engagement 201";
  const authorBio =
    "Her research centres on legal geographies of mineral exploration in the Canadian Arctic. Matilda previously worked as a research assistant on a public engagement project for flood risk management in Yorkshire, England. She graduated from the University of Oxford with an MSc in Water Science, Policy and Management.";
  assert("inline OCR subject indexes are classified as TOC/noise",
    classifyChunkNoise(inlineIndex, "Introduction").noiseScore >= 0.72);
  assert("inline OCR tables of contents are classified as TOC/noise",
    classifyChunkNoise(inlineToc, null).noiseScore >= 0.72);
  assert("author bio/frontmatter engagement mentions are classified as noise",
    classifyChunkNoise(authorBio, null).noiseScore >= 0.72);
}

section("community engagement synonym support");

{
  const query = "What role does community engagement play in flood resilience?";
  const publicEngagement =
    "Public engagement techniques are used to enhance flood risk communication between experts and lay people, build trust in risk-analysis decisions, and avoid alienating participants.";
  const localKnowledge =
    "The project used a bottom-up survey to incorporate local knowledge from citizens and rescue operators into a decision-support knowledge base.";
  const outreach =
    "A systematic outreach approach and sustained community engagement solicits input from citizens and rescue operators before, during, and after disaster.";
  assert("public engagement is direct support for community-engagement query",
    querySupportLevel(query, SCORE_DIRECT + 0.05, publicEngagement) === "direct");
  assert("local knowledge is direct support for community-engagement query",
    querySupportLevel(query, SCORE_DIRECT + 0.05, localKnowledge) === "direct");
  assert("systematic outreach remains direct community-engagement support",
    querySupportLevel(query, SCORE_DIRECT + 0.05, outreach) === "direct");
}

section("upload filename safety");

{
  assert("upload filename preserves normal PDF name",
    safePdfUploadFilename("JEM May-June 2025.pdf") === "JEM May-June 2025.pdf");
  assert("upload filename strips path traversal directories",
    safePdfUploadFilename("..\\..\\JEM May-June 2025.pdf") === "JEM May-June 2025.pdf");
  assert("upload filename replaces unsafe characters",
    safePdfUploadFilename("client:earthquake?.pdf") === "client_earthquake_.pdf");

  let rejected = false;
  try {
    safePdfUploadFilename("notes.txt");
  } catch {
    rejected = true;
  }
  assert("upload filename rejects non-PDF extension", rejected);
}

section("upload PDF type detection");

{
  assert("PDF MIME type is accepted",
    isLikelyPdfUpload({ mimetype: "application/pdf", originalName: "client.bin" }));
  assert("uppercase PDF extension is accepted with generic MIME",
    isLikelyPdfUpload({ mimetype: "application/octet-stream", originalName: "Client Report.PDF" }));
  assert("non-PDF upload is rejected",
    !isLikelyPdfUpload({ mimetype: "text/plain", originalName: "notes.txt" }));
}

section("upload filename de-duplication");

{
  const existing = new Set(["client.pdf", "client-2.pdf"]);
  assert("unique upload filename preserves unused name",
    uniquePdfUploadFilename("new-client.pdf", (candidate) => existing.has(candidate)) === "new-client.pdf");
  assert("unique upload filename appends first available suffix",
    uniquePdfUploadFilename("client.pdf", (candidate) => existing.has(candidate)) === "client-3.pdf");
  assert("unique upload filename preserves PDF extension case",
    uniquePdfUploadFilename("Client.PDF", (candidate) => candidate === "Client.PDF") === "Client-2.PDF");
}

section("destructive reset safety");

{
  assert("reset disabled without explicit env flag",
    !isCandidateIndexResetAllowed({ env: {}, confirmation: "RESET" }));
  assert("reset disabled without exact confirmation",
    !isCandidateIndexResetAllowed({ env: { RAG_ALLOW_DESTRUCTIVE_RESET: "true" }, confirmation: "reset" }));
  assert("reset allowed only with env flag and exact confirmation",
    isCandidateIndexResetAllowed({ env: { RAG_ALLOW_DESTRUCTIVE_RESET: "true" }, confirmation: "RESET" }));
}

console.log(`\n${"-".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAIL - ${failed} test(s) did not pass.`);
  process.exit(1);
}
console.log(`\nPASS - all ${passed} tests passed.`);
