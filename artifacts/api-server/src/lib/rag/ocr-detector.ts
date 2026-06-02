/**
 * OCR artifact detector — standalone module.
 *
 * Produces a structured per-document artifact report for:
 *   - before/after cleanup comparison
 *   - per-chunk noise scoring
 *   - ingestion pipeline diagnostics
 *
 * All detection logic is in ocr-cleaner.ts (detectArtifacts / chunkNoiseScore).
 * This module provides the higher-level reporting functions.
 */

import fs from "node:fs";
import path from "node:path";
import { detectArtifacts } from "./ocr-cleaner.js";
import type { ArtifactReport } from "./ocr-cleaner.js";

export interface DocumentArtifactSummary {
  documentId: string;
  filename: string;
  rawArtifacts: ArtifactReport;
  cleanArtifacts: ArtifactReport;
  improvement: Record<string, number>; // raw count − clean count per artifact type
  totalRawArtifacts: number;
  totalCleanArtifacts: number;
  artifactsRemoved: number;
  artifactsRemovedPct: number;
}

export interface CorpusArtifactReport {
  generatedAt: string;
  documents: DocumentArtifactSummary[];
  corpusTotals: {
    rawTotal: number;
    cleanTotal: number;
    removed: number;
    removedPct: number;
    byType: Record<string, { raw: number; clean: number; removed: number }>;
  };
}

/**
 * Generate a full before/after artifact report for the corpus.
 * Reads raw and clean document text from the data directories.
 */
export function generateCorpusArtifactReport(
  rawDir: string,
  cleanDir: string
): CorpusArtifactReport {
  const documents: DocumentArtifactSummary[] = [];

  const rawFiles = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.endsWith(".txt"))
    : [];

  for (const rawFile of rawFiles) {
    const docId = rawFile.replace(/\.raw\.txt$/, "").replace(/\.txt$/, "");
    const cleanFile = `${docId}.txt`;
    const cleanPath = path.join(cleanDir, cleanFile);
    const rawPath = path.join(rawDir, rawFile);

    if (!fs.existsSync(cleanPath)) continue;

    const rawText = fs.readFileSync(rawPath, "utf8");
    const cleanText = fs.readFileSync(cleanPath, "utf8");

    const rawArtifacts = detectArtifacts(rawText);
    const cleanArtifacts = detectArtifacts(cleanText);

    const rawTotal = Object.values(rawArtifacts.counts).reduce((a, b) => a + b, 0);
    const cleanTotal = Object.values(cleanArtifacts.counts).reduce((a, b) => a + b, 0);
    const removed = rawTotal - cleanTotal;

    const improvement: Record<string, number> = {};
    for (const key of new Set([...Object.keys(rawArtifacts.counts), ...Object.keys(cleanArtifacts.counts)])) {
      improvement[key] = (rawArtifacts.counts[key] ?? 0) - (cleanArtifacts.counts[key] ?? 0);
    }

    // Try to get the original filename from the clean JSON metadata
    let filename = docId;
    const metaPath = path.join(cleanDir, `${docId}.json`);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { filename?: string };
        filename = meta.filename ?? docId;
      } catch { /* ignore */ }
    }

    documents.push({
      documentId: docId,
      filename,
      rawArtifacts,
      cleanArtifacts,
      improvement,
      totalRawArtifacts: rawTotal,
      totalCleanArtifacts: cleanTotal,
      artifactsRemoved: removed,
      artifactsRemovedPct: rawTotal > 0 ? Math.round((removed / rawTotal) * 100) : 0,
    });
  }

  // Corpus-level aggregation
  const byType: Record<string, { raw: number; clean: number; removed: number }> = {};
  let corpusRaw = 0, corpusClean = 0;

  for (const doc of documents) {
    corpusRaw += doc.totalRawArtifacts;
    corpusClean += doc.totalCleanArtifacts;
    for (const [k, rawCount] of Object.entries(doc.rawArtifacts.counts)) {
      if (!byType[k]) byType[k] = { raw: 0, clean: 0, removed: 0 };
      byType[k].raw += rawCount;
    }
    for (const [k, cleanCount] of Object.entries(doc.cleanArtifacts.counts)) {
      if (!byType[k]) byType[k] = { raw: 0, clean: 0, removed: 0 };
      byType[k].clean += cleanCount;
    }
  }
  for (const k of Object.keys(byType)) {
    byType[k].removed = byType[k].raw - byType[k].clean;
  }

  return {
    generatedAt: new Date().toISOString(),
    documents,
    corpusTotals: {
      rawTotal: corpusRaw,
      cleanTotal: corpusClean,
      removed: corpusRaw - corpusClean,
      removedPct: corpusRaw > 0 ? Math.round(((corpusRaw - corpusClean) / corpusRaw) * 100) : 0,
      byType,
    },
  };
}
