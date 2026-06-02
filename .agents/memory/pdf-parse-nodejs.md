---
name: pdf-parse Node.js compatibility
description: pdf-parse@2.x crashes in Node.js due to pdfjs-dist browser Canvas dependencies; always use v1.1.1.
---

## Rule
Always use `pdf-parse@1.1.1` in Node.js server code. Never upgrade to v2.x.

**Why:** pdf-parse@2.x imports `pdfjs-dist` which pulls in browser-only Canvas APIs (`DOMMatrix`, `ImageData`, `Path2D`). These crash on startup in Node.js with `ReferenceError: DOMMatrix is not defined`. The error appears at module load time before any request is served.

**How to apply:** When adding PDF parsing to any Express/Node.js artifact, pin `pdf-parse@1.1.1` explicitly. The v1 API: `const pdfParse = require('pdf-parse'); const data = await pdfParse(buffer, { pagerender: async (pageData) => {...} });` — returns `{ text, numpages, info }`.
