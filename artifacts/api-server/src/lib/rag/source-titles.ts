/**
 * Client-friendly display titles for known source PDFs.
 *
 * Maps raw filenames (as stored in sourceFile) to human-readable titles
 * for display in the client UI. The raw sourceFile is preserved for
 * debugging and citation traceability.
 */

const SOURCE_TITLE_MAP: Record<string, string> = {
  "Flood_Risk_Management-OCR_1780399724237.pdf":
    "Flood Risk Management (FRM Book)",
  "JEM_2024_Special_Issue_1780399724235.pdf":
    "JEM 2024 Special Issue",
  "bdevito67,+JEM_20-8-08-Wood-Practical+flood+risk_1780399724236.pdf":
    "Practical Flood Risk Reduction (Wood, JEM 20-8)",
  "bdevito67,+JEM_21-1-04-Huang_1780399724236.pdf":
    "Japan Flood Warning System (Huang, JEM 21-1)",
  "bdevito67,+JEM_V3N2_3_1780399724236.pdf":
    "Flood Risk Communication & Governance (JEM V3N2)",
  "bdevito67,+JEM_V3N3_3_1780399724236.pdf":
    "Flood Risk Assessment Methods (JEM V3N3)",
  "bdevito67,+JEM_V6N5_9_1780399724235.pdf":
    "Community Resilience & Recovery (JEM V6N5)",
  "bdevito67,+JEMv9n1_7_1780399724237.pdf":
    "Emergency Response Planning (JEM V9N1)",
  "bdevito67,+JEM-12-1-04-Kohn_1780399724237.pdf":
    "Personal Preparedness Curriculum (Kohn, JEM 12-1)",
};

/**
 * Return a human-readable display title for a source file.
 * Falls back to a sanitized version of the basename if not in the map.
 */
export function getDisplayTitle(sourceFile: string): string {
  const basename = sourceFile.split(/[\\/]/).pop() ?? sourceFile;
  const mapped = SOURCE_TITLE_MAP[basename];
  if (mapped) return mapped;

  return basename
    .replace(/_\d{13}/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/^bdevito67[,+]+/, "")
    .replace(/[_+,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
