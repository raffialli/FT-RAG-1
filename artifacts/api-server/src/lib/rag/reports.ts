import fs from "node:fs";
import path from "node:path";
import type { ComparisonReport } from "./types.js";

const DATA_DIR = process.env.RAG_DATA_DIR ?? path.join(process.cwd(), "candidate-rag", "data");
const REPORTS_PATH = path.join(DATA_DIR, "reports", "comparison-reports.json");

export function loadReports(): ComparisonReport[] {
  if (!fs.existsSync(REPORTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf8")) as ComparisonReport[];
  } catch {
    return [];
  }
}

export function saveReport(report: Omit<ComparisonReport, "id" | "createdAt">): ComparisonReport {
  const reports = loadReports();
  const newReport: ComparisonReport = {
    ...report,
    id: `report_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
  reports.unshift(newReport);
  fs.mkdirSync(path.dirname(REPORTS_PATH), { recursive: true });
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports.slice(0, 100), null, 2));
  return newReport;
}
