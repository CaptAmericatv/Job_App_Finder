import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSaved, snapshot, runScan, canScanNow, startSchedule } from './src/scanner.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// SERVER_PORT is what BisectHosting / Pterodactyl panels provide.
const PORT = +process.env.PORT || +process.env.SERVER_PORT || 3000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  // /lib/* is shared code from src/ (used by the browser too); /vendor/leaflet/* is the map library.
  let base = join(ROOT, 'public');
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (pathname.startsWith('/lib/')) { base = join(ROOT, 'src'); rel = pathname.slice(4); }
  else if (pathname.startsWith('/vendor/leaflet/')) { base = join(ROOT, 'node_modules', 'leaflet', 'dist'); rel = pathname.slice(15); }
  const file = normalize(join(base, rel));
  if (!file.startsWith(base) || (pathname.startsWith('/lib/') && !/^\/(estimate)\.js$/.test(rel))) {
    res.writeHead(404); return res.end('Not found');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/results') return sendJson(res, 200, snapshot());
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const check = canScanNow();
      if (!check.ok) return sendJson(res, 429, { error: check.reason });
      runScan();
      return sendJson(res, 202, { started: true });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

await loadSaved();
startSchedule();
server.listen(PORT, '0.0.0.0', () => console.log(`Job App Finder running at http://localhost:${PORT}`));
