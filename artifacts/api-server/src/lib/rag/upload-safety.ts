export function isLikelyPdfUpload(input: {
  mimetype?: string | null;
  originalName?: string | null;
}): boolean {
  const mimetype = input.mimetype?.toLowerCase() ?? "";
  const originalName = input.originalName?.trim().toLowerCase() ?? "";
  return mimetype === "application/pdf" || originalName.endsWith(".pdf");
}

export function safePdfUploadFilename(originalName: string): string {
  const basename = originalName
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.trim() ?? "";

  const withoutControlChars = basename.replace(/[\u0000-\u001f\u007f]/g, "");
  const safeName = withoutControlChars
    .replace(/[^a-zA-Z0-9._ ()+\-]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .trim();

  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Uploaded PDF filename is empty or unsafe.");
  }
  if (!safeName.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only PDF files are supported.");
  }
  return safeName;
}

export function uniquePdfUploadFilename(
  safeName: string,
  exists: (candidate: string) => boolean
): string {
  if (!exists(safeName)) return safeName;

  const match = /^(.*?)(\.pdf)$/i.exec(safeName);
  if (!match) {
    throw new Error("Only PDF files are supported.");
  }

  const [, stem, extension] = match;
  for (let counter = 2; counter <= 1000; counter++) {
    const candidate = `${stem}-${counter}${extension}`;
    if (!exists(candidate)) return candidate;
  }

  throw new Error("Could not allocate a unique uploaded PDF filename.");
}
