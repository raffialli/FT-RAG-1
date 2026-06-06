import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

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

async function loadChunker(): Promise<{
  chunkDocument: (input: {
    documentId: string;
    sourceFile: string;
    cleanedText: string;
    pageTexts: string[];
    cleaningFlags: string[];
  }) => Array<{
    chunkId: string;
    documentId: string;
    sourceFile: string;
    pageStart: number;
    pageEnd: number;
    sectionPath: string | null;
    text: string;
    cleaningFlags: string[];
    qualityNotes: string[];
  }>;
}> {
  const bundled = await build({
    entryPoints: [path.join(TEST_DIR, "chunker.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("Failed to bundle chunker test module.");
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const { chunkDocument } = await loadChunker();

section("chunking preserves uploaded-document answer facts");

{
  const cleanedText = [
    "Geotechnical reconnaissance of the February 6, 2023, Pazarcık Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaraş-Türkiye earthquakes.",
    "",
    "ABSTRACT",
    "On February 6, 2023, two major earthquakes occurred in southern Türkiye. The first event was centered near Pazarcık with Mw = 7.7. The second event was centered near Elbistan with Mw = 7.6. These nearby title and abstract sentences are the client-visible answer facts. The rest of the abstract describes site effects, lifeline disruption, reconnaissance methods, and emergency management observations from affected provinces. ".repeat(3),
  ].join("\n");
  const chunks = chunkDocument({
    documentId: "jem-earthquake",
    sourceFile: "JEM May-June 2025.pdf",
    cleanedText,
    pageTexts: [cleanedText],
    cleaningFlags: [],
  });
  const combined = chunks.map((c) => c.text).join("\n");
  assert("chunking keeps non-ASCII title/abstract magnitude facts",
    combined.includes("Pazarcık Mw = 7.7") && combined.includes("Elbistan Mw = 7.6"),
    combined);
  assert("chunking preserves source filename metadata",
    chunks.every((c) => c.sourceFile === "JEM May-June 2025.pdf"));
  assert("chunking preserves page attribution for single-page extracted text",
    chunks.every((c) => c.pageStart === 1 && c.pageEnd === 1));
}

{
  const setup = "The report summarizes emergency communications, shelter operations, and regional response coordination. ".repeat(10);
  const answerSpan =
    "The uploaded document identifies two principal seismic events. Pazarcik is listed with Mw = 7.7. Elbistan is listed with Mw = 7.6. The locations are presented together as Kahramanmaras-Turkiye. ";
  const tail = "Later sections discuss field surveys, damage observations, soil response, and public infrastructure recovery. ".repeat(10);
  const cleanedText = `${setup}${answerSpan}${tail}`;
  const chunks = chunkDocument({
    documentId: "nearby-sentence-answer",
    sourceFile: "client-upload.pdf",
    cleanedText,
    pageTexts: [cleanedText],
    cleaningFlags: [],
  });
  assert("chunking keeps nearby answer sentences together",
    chunks.some((c) => c.text.includes("Pazarcik is listed with Mw = 7.7") && c.text.includes("Elbistan is listed with Mw = 7.6")));
}

console.log(`\n${"-".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAIL - ${failed} test(s) did not pass.`);
  process.exit(1);
}
console.log(`\nPASS - all ${passed} tests passed.`);
