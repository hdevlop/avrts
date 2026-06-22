/**
 * Tiny static server for the browser demo. Serves index.html, src/styles.css,
 * and dist/main.js. Run with `bun run serve:demo`.
 */
import { join } from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(process.env["PORT"] ?? 5173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(ROOT, path);
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const mime = MIME[filePath.slice(filePath.lastIndexOf("."))] ?? "application/octet-stream";
    return new Response(file, { headers: { "Content-Type": mime } });
  },
});

console.log(`avrts demo running at http://localhost:${PORT}`);
