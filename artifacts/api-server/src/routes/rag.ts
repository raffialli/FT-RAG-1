import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import {
  ingestAllDocuments,
  ingestUploadedFile,
  loadDocumentsManifest,
  getSourcePdfPaths,
  getUploadedPdfPaths,
} from "../lib/rag/ingester.js";
import { hybridRetrieve } from "../lib/rag/retriever.js";
import { synthesizeAnswer } from "../lib/rag/answer-gen.js";
import { loadVectorIndex, resetVectorIndex } from "../lib/rag/vector-store.js";
import { testConnectivity } from "../lib/rag/embeddings.js";
import { loadReports, saveReport } from "../lib/rag/reports.js";

const DATA_DIR = process.env.RAG_DATA_DIR ?? path.join(path.resolve(process.cwd(), "..", ".."), "candidate-rag", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are supported"));
    }
  },
});

const router = Router();

// GET /api/rag/status
router.get("/rag/status", async (req, res) => {
  try {
    const docs = loadDocumentsManifest();
    const index = loadVectorIndex();
    const chunkCount = docs.reduce((s, d) => s + d.chunkCount, 0);
    const lastIngestedDoc = docs.sort(
      (a, b) => new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime()
    )[0];

    const sourcePdfs = getSourcePdfPaths();
    const uploadedPdfs = getUploadedPdfPaths();
    const notes: string[] = [];
    if (sourcePdfs.length > 0) notes.push(`${sourcePdfs.length} source PDFs available in attached_assets/`);
    if (uploadedPdfs.length > 0) notes.push(`${uploadedPdfs.length} uploaded PDFs`);
    if (index.records.length === 0 && (sourcePdfs.length > 0 || uploadedPdfs.length > 0)) {
      notes.push('Documents available but not yet ingested. Click "Ingest Documents" to start.');
    }

    res.json({
      documentCount: docs.length,
      chunkCount,
      vectorCount: index.records.length,
      ready: index.records.length > 0,
      embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text:latest",
      generationModel: process.env.GENERATION_MODEL ?? "qwen3.5:122b",
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "https://ollama.com",
      lastIngestedAt: lastIngestedDoc?.ingestedAt ?? null,
      notes,
    });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/rag/documents
router.get("/rag/documents", (_req, res) => {
  const docs = loadDocumentsManifest();
  res.json(docs);
});

// GET /api/rag/chunks
router.get("/rag/chunks", (req, res) => {
  const { documentId } = req.query as { documentId?: string };
  const index = loadVectorIndex();
  const records = documentId
    ? index.records.filter((r) => r.documentId === documentId)
    : index.records;

  res.json(
    records.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      sourceFile: r.sourceFile,
      pageStart: r.pageStart,
      pageEnd: r.pageEnd,
      sectionPath: r.sectionPath,
      text: r.text.substring(0, 500) + (r.text.length > 500 ? "…" : ""),
      cleaningFlags: r.cleaningFlags,
      qualityNotes: [],
    }))
  );
});

// POST /api/rag/ingest
router.post("/rag/ingest", async (req, res) => {
  try {
    const body = req.body as { rebuild?: boolean };
    const rebuild = body?.rebuild === true;
    req.log.info({ rebuild }, "Starting document ingestion");
    const result = await ingestAllDocuments(rebuild);
    req.log.info({ result }, "Ingestion complete");
    res.json(result);
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/rag/reset
router.post("/rag/reset", (_req, res) => {
  try {
    resetVectorIndex();
    // Clear manifests and chunks
    const manifestPath = path.join(DATA_DIR, "manifests", "documents.json");
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    const chunksDir = path.join(DATA_DIR, "chunks");
    if (fs.existsSync(chunksDir)) {
      for (const f of fs.readdirSync(chunksDir)) {
        fs.unlinkSync(path.join(chunksDir, f));
      }
    }
    res.json({ success: true, message: "Vector index and all document data reset." });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

// POST /api/rag/query
router.post("/rag/query", async (req, res) => {
  const start = Date.now();
  try {
    const body = req.body as {
      query: string;
      topK?: number;
      includeEvidence?: boolean;
      includeDebug?: boolean;
    };

    if (!body.query?.trim()) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const topK = Math.min(body.topK ?? 5, 10);
    req.log.info({ query: body.query.substring(0, 100) }, "RAG query");

    const { chunks, debug } = await hybridRetrieve(body.query, topK);
    const answer = await synthesizeAnswer(body.query, chunks);

    const result = {
      ...answer,
      retrievedChunks: (body.includeEvidence !== false) ? chunks : [],
      durationMs: Date.now() - start,
      debugTrace: body.includeDebug ? debug : null,
    };

    // Auto-save to reports
    saveReport({
      question: body.query,
      candidateAnswer: answer.answer,
      candidateConfidence: answer.confidence,
      candidateSources: answer.sources,
      evidenceQuality: answer.confidence === "high" ? "strong" : answer.confidence === "medium" ? "partial" : "weak",
      classification: classifyQuestion(body.query),
      notes: null,
    });

    res.json(result);
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/rag/upload
router.post("/rag/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    // Rename to original filename
    const originalName = req.file.originalname;
    const destPath = path.join(UPLOADS_DIR, originalName);
    fs.renameSync(req.file.path, destPath);

    req.log.info({ filename: originalName }, "Processing uploaded PDF");
    const result = await ingestUploadedFile(destPath);
    res.json(result);
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/rag/reports
router.get("/rag/reports", (_req, res) => {
  res.json(loadReports());
});

// GET /api/rag/test-model
router.get("/rag/test-model", async (req, res) => {
  try {
    req.log.info("Testing Ollama connectivity");
    const result = await testConnectivity();
    res.json(result);
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

function classifyQuestion(query: string): string {
  const q = query.toLowerCase();
  if (/flood|inundation|surge|hurricane|storm/.test(q)) return "flood-hazard";
  if (/evacuation|shelter|emergency|preparedness/.test(q)) return "emergency-management";
  if (/risk|vulnerability|exposure/.test(q)) return "risk-assessment";
  if (/climate|sea level|temperature|precipitation/.test(q)) return "climate";
  if (/building|structure|infrastructure/.test(q)) return "infrastructure";
  return "general";
}

export default router;
