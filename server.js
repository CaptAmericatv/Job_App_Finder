import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geocode, findBusinesses } from './src/places.js';
import { crawlBusiness } from './src/crawler.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// SERVER_PORT is what BisectHosting / Pterodactyl panels provide.
const PORT = +process.env.PORT || +process.env.SERVER_PORT || 3000;
const CONCURRENCY = +process.env.CONCURRENCY || 8;
const MAX_BUSINESSES = +process.env.MAX_BUSINESSES || 400;

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

async function handleSearch(req, res, params) {
  const lat = +params.get('lat');
  const lon = +params.get('lon');
  const radius = Math.min(Math.max(+params.get('radius') || 3, 0.1), 30);
  const limit = Math.min(+params.get('limit') || 150, MAX_BUSINESSES);
  const includeNoWebsite = params.get('noWebsite') === '1';
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJson(res, 400, { error: 'Pick a location first' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => send('ping', {}), 15000);

  try {
    send('status', { message: 'Finding businesses on the map…' });
    const all = await findBusinesses({ lat, lon, radiusMiles: radius, includeNoWebsite });
    const businesses = all.slice(0, limit);
    send('businesses', { businesses, total: all.length, limited: all.length > limit });

    const queue = [...businesses];
    let done = 0;
    const worker = async () => {
      while (queue.length && !closed) {
        const b = queue.shift();
        const result = b.website ? await crawlBusiness(b.website) : { status: 'no-website', jobs: [] };
        done++;
        send('result', { id: b.id, ...result, done, total: businesses.length });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    send('done', { total: businesses.length });
  } catch (e) {
    send('fail', { error: e.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/geocode') {
      const q = url.searchParams.get('q');
      if (!q) return sendJson(res, 400, { error: 'Enter an address or city' });
      return sendJson(res, 200, await geocode(q));
    }
    if (url.pathname === '/api/search') return handleSearch(req, res, url.searchParams);
    if (url.pathname === '/api/crawl') {
      // Check one website (handy for testing).
      return sendJson(res, 200, await crawlBusiness(url.searchParams.get('url')));
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Job App Finder running at http://localhost:${PORT}`));
