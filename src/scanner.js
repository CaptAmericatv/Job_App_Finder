// Scans the home area on a schedule and saves the results to disk,
// so the page can show jobs right away instead of searching each time.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBusinesses, findTowns } from './places.js';
import { crawlBusiness } from './crawler.js';
import { localityChecker } from './locality.js';

export const HOME = {
  name: process.env.HOME_NAME || 'Fort Payne, AL',
  lat: +process.env.HOME_LAT || 34.4443,
  lon: +process.env.HOME_LON || -85.7197,
  radiusMiles: +process.env.RADIUS_MILES || 15,
};
const HOME_STATE = process.env.HOME_STATE || (HOME.name.split(',')[1] || 'AL').trim();
const SCAN_EVERY_HOURS = +process.env.SCAN_EVERY_HOURS || 12;
const MIN_MINUTES_BETWEEN_MANUAL = 30;
const CONCURRENCY = +process.env.CONCURRENCY || 8;
const MAX_BUSINESSES = +process.env.MAX_BUSINESSES || 1000;

const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url));
const FILE = join(DATA_DIR, 'results.json');

// data = { businesses: { [id]: { ...business, result, checkedAt } }, lastScan }
let data = { businesses: {}, lastScan: null };
let progress = null; // { startedAt, done, total } while a scan runs
let saving = Promise.resolve();

export async function loadSaved() {
  try {
    data = JSON.parse(await readFile(FILE, 'utf8'));
    data.businesses ||= {};
    annotateAll();
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read saved results:', e.message);
  }
}

function save() {
  // Write to a temp file, then rename, so a crash never leaves a half-written file.
  saving = saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FILE + '.tmp', JSON.stringify(data));
    await rename(FILE + '.tmp', FILE);
  }).catch((e) => console.error('Could not save results:', e.message));
  return saving;
}

export function snapshot() {
  return { home: HOME, lastScan: data.lastScan, scanning: progress, businesses: Object.values(data.businesses), everyHours: SCAN_EVERY_HOURS };
}

// Keep each job's first-seen date across scans, so new ones can be marked.
export function mergeResult(prev, next, now) {
  // A site that failed to load this time keeps what it had last time.
  if (next.status === 'error' && prev && prev.status !== 'error') return { ...prev, stale: true };
  const firstSeen = new Map((prev?.jobs || []).map((j) => [j.title.toLowerCase(), j.firstSeen]));
  return { ...next, jobs: next.jobs.map((j) => ({ ...j, firstSeen: firstSeen.get(j.title.toLowerCase()) || now })) };
}

export function canScanNow() {
  if (progress) return { ok: false, reason: 'A check is already running.' };
  const last = data.lastScan?.finishedAt ? Date.parse(data.lastScan.finishedAt) : 0;
  const wait = MIN_MINUTES_BETWEEN_MANUAL * 60_000 - (Date.now() - last);
  if (wait > 0) return { ok: false, reason: `Checked recently. Try again in ${Math.ceil(wait / 60_000)} min.` };
  return { ok: true };
}

export async function runScan() {
  if (progress) return;
  const startedAt = new Date().toISOString();
  progress = { startedAt, done: 0, total: 0, message: 'Finding businesses on the map…' };
  try {
    const all = await findBusinesses({ ...HOME, includeNoWebsite: true });
    const towns = await findTowns(HOME).catch(() => []);
    if (towns.length) data.towns = towns;
    const withSite = all.filter((b) => b.website).slice(0, MAX_BUSINESSES);
    const keep = new Set([...all.filter((b) => !b.website), ...withSite].map((b) => b.id));
    // Drop businesses that are no longer on the map (or outside the limit).
    for (const id of Object.keys(data.businesses)) if (!keep.has(id)) delete data.businesses[id];
    for (const b of all) {
      if (!keep.has(b.id)) continue;
      const prev = data.businesses[b.id];
      data.businesses[b.id] = { ...b, result: b.website ? prev?.result || null : { status: 'no-website', jobs: [] }, checkedAt: prev?.checkedAt || null };
    }
    progress = { startedAt, done: 0, total: withSite.length, message: `Checking ${withSite.length} business websites…` };

    // Several places on the same website (Dollar General, post offices…) are a chain.
    const perDomain = new Map();
    for (const b of withSite) perDomain.set(domainOf(b.website), (perDomain.get(domainOf(b.website)) || 0) + 1);
    const isChain = (b) => !!b.brand || perDomain.get(domainOf(b.website)) > 1;

    const queue = [...withSite];
    const worker = async () => {
      while (queue.length) {
        const b = queue.shift();
        const now = new Date().toISOString();
        const chain = isChain(b);
        // Facebook doesn't allow automated reading; point to the page instead.
        let next = /(^|\.)(facebook|fb)\.com$/i.test(new URL(b.website).hostname)
          ? { status: 'hiring-page', jobs: [], careersUrl: b.website, note: 'Uses Facebook as its website. Check their page for hiring posts.' }
          : await crawlBusiness(b.website, { chain });
        if (chain && next.status === 'error') next = chainLead(b);
        const entry = data.businesses[b.id];
        entry.result = mergeResult(entry.result, next, now);
        entry.checkedAt = now;
        progress.done++;
        if (progress.done % 25 === 0) save();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    annotateAll();
    delete data.rescanRequested;
    data.lastScan = { startedAt, finishedAt: new Date().toISOString(), checked: withSite.length, total: all.length };
    console.log(`Scan done: ${withSite.length} websites checked, ${countJobs()} jobs.`);
  } catch (e) {
    // Map data unavailable: keep the old results and try again next round.
    data.lastScan = { ...(data.lastScan || {}), error: e.message, failedAt: new Date().toISOString() };
    console.error('Scan failed:', e.message);
  } finally {
    progress = null;
    await save();
  }
}

// Mark each job local or elsewhere ("where"/"whereNote"), using the towns in
// the area. Chains (brand, or several places on one website) list company-wide jobs.
export function annotateAll() {
  const list = Object.values(data.businesses);
  const towns = [
    HOME.name.split(',')[0],
    ...(data.towns || []),
    ...list.map((b) => b.city).filter(Boolean),
  ];
  const where = localityChecker({ towns, homeState: HOME_STATE });
  const perDomain = new Map();
  for (const b of list) if (b.website) perDomain.set(domainOf(b.website), (perDomain.get(domainOf(b.website)) || 0) + 1);
  for (const b of list) {
    const chain = !!b.brand || (b.website && perDomain.get(domainOf(b.website)) > 1);
    for (const j of b.result?.jobs || []) {
      const w = where(j, { chain });
      j.where = w.where;
      j.whereNote = w.note || null;
    }
  }
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.'); } catch { return url; }
}

// Big chains' sites often refuse automated visitors; list the store as a lead instead.
export function chainLead(b) {
  return {
    status: 'hiring-page',
    jobs: [],
    careersUrl: b.website,
    note: `Chain store${b.brand ? ` (${b.brand})` : ''}. Their website can't be checked automatically. Apply on their careers site or ask in the store.`,
  };
}

function countJobs() {
  return Object.values(data.businesses).reduce((n, b) => n + (b.result?.jobs?.length || 0), 0);
}

// Run a scan when the last good one is older than SCAN_EVERY_HOURS.
// A failed scan is retried after 15 minutes.
export function startSchedule() {
  const tick = () => {
    const last = data.lastScan?.finishedAt ? Date.parse(data.lastScan.finishedAt) : 0;
    const failed = data.lastScan?.failedAt ? Date.parse(data.lastScan.failedAt) : 0;
    // rescanRequested: set in data/results.json by hand (or by a deploy) to check early.
    const due = (data.rescanRequested || Date.now() - last > SCAN_EVERY_HOURS * 3_600_000) && Date.now() - failed > 15 * 60_000;
    if (due) runScan();
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 10 * 60_000).unref?.();
}
