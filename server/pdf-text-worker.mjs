/**
 * PDF text extraction, run as a child process by schedule.js.
 *
 * pdf-parse bundles an old pdf.js and runs untrusted student uploads, so it
 * stays out of the API process. Reads the PDF bytes from stdin, prints the
 * extracted text to stdout, exits non-zero on any failure. The parent owns the
 * timeout, the stdout cap, and the kill.
 *
 *   PDF_MAX_PAGES  pages to read (default 40)
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const MAX_PAGES = Math.max(1, Number(process.env.PDF_MAX_PAGES) || 40);

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error("no input");
  const data = await pdfParse(buffer, { max: MAX_PAGES });
  await new Promise((resolve, reject) => {
    process.stdout.write(String(data?.text || ""), (err) => (err ? reject(err) : resolve()));
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exit(1);
  }
);
