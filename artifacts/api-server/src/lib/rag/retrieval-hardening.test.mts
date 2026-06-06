import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Search, exactPhraseSearch, matchesNormalizedSearch, normalizeForSearch, tokenize } from "./bm25.ts";
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
