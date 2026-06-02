/**
 * PDF ingestion pipeline:
 * PDF → OCR cleanup → section-aware chunking → embeddings → vector store
 *
 * Uses pdf-parse@1.1.1 (Node.js native, no browser deps)
 */

import fs from "node:fs";
import path from "node:path";
// pdf-parse v1.1.1 — no bundled TS types, use dynamic require
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (
  buf: Buffer,
  options?: {
    pagerender?: (pageData: {
      getTextContent: () => Promise<{ items: { str: string; transform?: number[] }[] }>;
    }) => Promise<string>;
  }
) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;

import { cleanOcrText } from "./ocr-cleaner.js";
import { chunkDocument } from "./chunker.js";
import { embedBatch } from "./embeddings.js";
import {
  addOrUpdateRecords,
  loadVectorIndex,
  resetVectorIndex,
} from "./vector-store.js";
import type { RagChunk, RagDocument } from "./types.js";

const DATA_DIR = process.env.RAG_DATA_DIR ?? path.join(process.cwd(), "candidate-rag", "data");
const DOCS_MANIFEST_PATH = path.join(DATA_DIR, "manifests", "documents.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const CLEAN_DOCS_DIR = path.join(DATA_DIR, "clean-documents");
const CHUNKS_DIR = path.join(DATA_DIR, "chunks");
const SOURCE_PDFS_DIR = path.join(process.cwd(), "attached_assets");

export interface IngestResult {
  success: boolean;
  documentsIngested: number;
  chunksCreated: number;
  vectorsCreated: number;
  durationMs: number;
  errors: string[];
  warnings: string[];
  cleanupReport: Record<string, unknown>;
}

export function loadDocumentsManifest(): RagDocument[] {
  if (!fs.existsSync(DOCS_MANIFEST_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(DOCS_MANIFEST_PATH, "utf8")) as RagDocument[];
  } catch {
    return [];
  }
}

function saveDocumentsManifest(docs: RagDocument[]): void {
  fs.mkdirSync(path.dirname(DOCS_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(DOCS_MANIFEST_PATH, JSON.stringify(docs, null, 2));
}

export function getSourcePdfPaths(): string[] {
  if (!fs.existsSync(SOURCE_PDFS_DIR)) return [];
  return fs
    .readdirSync(SOURCE_PDFS_DIR)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => path.join(SOURCE_PDFS_DIR, f));
}

export function getUploadedPdfPaths(): string[] {
  if (!fs.existsSync(UPLOADS_DIR)) return [];
  return fs
    .readdirSync(UPLOADS_DIR)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => path.join(UPLOADS_DIR, f));
}

async function extractPdfText(filePath: string): Promise<{
  fullText: string;
  pageTexts: string[];
  numpages: number;
}> {
  const buffer = fs.readFileSync(filePath);
  const pageTextsCollected: string[] = [];

  const data = await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      pageTextsCollected.push(pageText);
      return pageText;
    },
  });

  return {
    fullText: data.text,
    pageTexts: pageTextsCollected.length > 0 ? pageTextsCollected : [data.text],
    numpages: data.numpages,
  };
}

export async function ingestPdf(
  filePath: string,
  rebuild = false
): Promise<{ doc: RagDocument; chunks: RagChunk[]; errors: string[]; warnings: string[] }> {
  const filename = path.basename(filePath);
  const documentId = filename.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  const errors: string[] = [];
  const warnings: string[] = [];

  // Skip if already ingested and not rebuilding
  const manifest = loadDocumentsManifest();
  const existing = manifest.find((d) => d.id === documentId);
  if (existing && !rebuild) {
    const existingChunks = loadChunksForDocument(documentId);
    if (existingChunks.length > 0) {
      return { doc: existing, chunks: existingChunks, errors, warnings };
    }
  }

  let fullText = "";
  let pageTexts: string[] = [];
  let numpages = 0;

  try {
    const extracted = await extractPdfText(filePath);
    fullText = extracted.fullText;
    pageTexts = extracted.pageTexts;
    numpages = extracted.numpages;
  } catch (e) {
    errors.push(`PDF parse error: ${String(e)}`);
    return {
      doc: {
        id: documentId,
        filename,
        filePath,
        pageCount: 0,
        chunkCount: 0,
        ingestedAt: new Date().toISOString(),
        status: "error",
        cleaningFlags: [],
      },
      chunks: [],
      errors,
      warnings,
    };
  }

  // Clean OCR text
  const cleaned = cleanOcrText(fullText, filename);
  if (cleaned.cleaningFlags.length > 0) {
    warnings.push(`Cleaning applied: ${cleaned.cleaningFlags.join(", ")}`);
  }
  if (cleaned.qualityNotes.length > 0) {
    warnings.push(`Quality: ${cleaned.qualityNotes.join(", ")}`);
  }

  // Save clean document
  saveCleanDocument(documentId, filename, cleaned.cleanedText, cleaned.cleaningFlags);

  // Chunk
  const chunks = chunkDocument({
    documentId,
    sourceFile: filename,
    cleanedText: cleaned.cleanedText,
    pageTexts,
    cleaningFlags: cleaned.cleaningFlags,
  });

  if (chunks.length === 0) {
    warnings.push("No usable chunks extracted from document");
  }

  saveChunksForDocument(documentId, chunks);

  const doc: RagDocument = {
    id: documentId,
    filename,
    filePath,
    pageCount: numpages,
    chunkCount: chunks.length,
    ingestedAt: new Date().toISOString(),
    status: "ingested",
    cleaningFlags: cleaned.cleaningFlags,
  };

  const newManifest = manifest.filter((d) => d.id !== documentId);
  newManifest.push(doc);
  saveDocumentsManifest(newManifest);

  return { doc, chunks, errors, warnings };
}

export async function ingestAllDocuments(rebuild = false): Promise<IngestResult> {
  const start = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleanupReport: Record<string, unknown> = {};

  if (rebuild) {
    resetVectorIndex();
    if (fs.existsSync(CHUNKS_DIR)) {
      for (const f of fs.readdirSync(CHUNKS_DIR)) {
        fs.unlinkSync(path.join(CHUNKS_DIR, f));
      }
    }
    if (fs.existsSync(DOCS_MANIFEST_PATH)) {
      fs.unlinkSync(DOCS_MANIFEST_PATH);
    }
  }

  const allPdfs = [...getSourcePdfPaths(), ...getUploadedPdfPaths()];

  if (allPdfs.length === 0) {
    return {
      success: false,
      documentsIngested: 0,
      chunksCreated: 0,
      vectorsCreated: 0,
      durationMs: Date.now() - start,
      errors: ["No PDF files found. Place PDFs in attached_assets/ or upload via the UI."],
      warnings,
      cleanupReport,
    };
  }

  let totalChunks = 0;
  let docsIngested = 0;
  const allNewChunks: RagChunk[] = [];

  for (const pdfPath of allPdfs) {
    const filename = path.basename(pdfPath);
    try {
      const result = await ingestPdf(pdfPath, rebuild);
      errors.push(...result.errors);
      warnings.push(...result.warnings.map((w) => `${filename}: ${w}`));
      cleanupReport[filename] = result.doc.cleaningFlags;

      if (result.doc.status === "ingested" && result.chunks.length > 0) {
        docsIngested++;
        totalChunks += result.chunks.length;

        // Only embed chunks that don't have vectors yet
        const vectorIndex = loadVectorIndex();
        const existingChunkIds = new Set(vectorIndex.records.map((r) => r.chunkId));
        const newChunks = rebuild
          ? result.chunks
          : result.chunks.filter((c) => !existingChunkIds.has(c.chunkId));
        allNewChunks.push(...newChunks);
      }
    } catch (e) {
      errors.push(`Failed to ingest ${filename}: ${String(e)}`);
    }
  }

  // Embed all new chunks in batch
  let totalVectors = 0;
  if (allNewChunks.length > 0) {
    try {
      const texts = allNewChunks.map((c) => c.text);
      const embeddings = await embedBatch(texts, 8);
      addOrUpdateRecords(allNewChunks, embeddings);
      totalVectors = allNewChunks.length;
    } catch (e) {
      errors.push(`Embedding failed: ${String(e)}`);
    }
  }

  return {
    success: errors.filter((e) => !e.includes("Embedding failed")).length === 0 || docsIngested > 0,
    documentsIngested: docsIngested,
    chunksCreated: totalChunks,
    vectorsCreated: totalVectors,
    durationMs: Date.now() - start,
    errors,
    warnings,
    cleanupReport,
  };
}

export async function ingestUploadedFile(filePath: string): Promise<IngestResult> {
  const start = Date.now();
  const result = await ingestPdf(filePath, true);

  let vectorsCreated = 0;
  const errors = [...result.errors];
  const warnings = [...result.warnings];

  if (result.chunks.length > 0) {
    try {
      const texts = result.chunks.map((c) => c.text);
      const embeddings = await embedBatch(texts, 8);
      addOrUpdateRecords(result.chunks, embeddings);
      vectorsCreated = result.chunks.length;
    } catch (e) {
      errors.push(`Embedding failed: ${String(e)}`);
    }
  }

  return {
    success: result.doc.status === "ingested",
    documentsIngested: result.doc.status === "ingested" ? 1 : 0,
    chunksCreated: result.chunks.length,
    vectorsCreated,
    durationMs: Date.now() - start,
    errors,
    warnings,
    cleanupReport: { [result.doc.filename]: result.doc.cleaningFlags },
  };
}

function saveCleanDocument(documentId: string, filename: string, text: string, flags: string[]): void {
  fs.mkdirSync(CLEAN_DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLEAN_DOCS_DIR, `${documentId}.txt`), text);
  fs.writeFileSync(
    path.join(CLEAN_DOCS_DIR, `${documentId}.json`),
    JSON.stringify({ documentId, filename, cleaningFlags: flags }, null, 2)
  );
}

function saveChunksForDocument(documentId: string, chunks: RagChunk[]): void {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const lines = chunks.map((c) => JSON.stringify(c)).join("\n");
  fs.writeFileSync(path.join(CHUNKS_DIR, `${documentId}.chunks.jsonl`), lines);
}

function loadChunksForDocument(documentId: string): RagChunk[] {
  const chunkFile = path.join(CHUNKS_DIR, `${documentId}.chunks.jsonl`);
  if (!fs.existsSync(chunkFile)) return [];
  try {
    return fs
      .readFileSync(chunkFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RagChunk);
  } catch {
    return [];
  }
}
