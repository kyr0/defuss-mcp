// VERIFIED: (site e2e) Serve docs/ like GitHub Pages: directory index files, a 404.html for unknown
// paths, and content types by extension. Run directly to browse the build:
// bun site/e2e/serve.ts [port]
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.md': 'text/markdown; charset=utf-8',
};

async function file(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return file(join(path, 'index.html'));
    return path;
  } catch {
    return undefined;
  }
}

export async function serve(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const target = normalize(join(DOCS, pathname));
    const found = target.startsWith(DOCS) ? await file(target) : undefined;
    const path = found ?? join(DOCS, '404.html');
    res.writeHead(found ? 200 : 404, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}` };
}

if (import.meta.main) {
  const { url } = await serve(Number(process.argv[2] ?? 4173));
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'serving docs', url }));
}
