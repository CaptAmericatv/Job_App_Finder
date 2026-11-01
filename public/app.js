import { applyEstimates, formatPay, formatHours } from '/lib/estimate.js';

const $ = (id) => document.getElementById(id);
const state = {
  lastFinished: null,
  businesses: new Map(),
  results: new Map(),
  jobs: [],
  tab: 'jobs',
  saved: loadSaved(),
};

// ---------- map ----------
const map = L.map('map').setView([34.4443, -85.7197], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const markers = L.layerGroup().addTo(map);
// Inline SVG pin, so the map doesn't need Leaflet's PNG marker images.
const PIN_ICON = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 0C5.6 0 0 5.6 0 12.5 0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0z" fill="#2a81cb" stroke="#1d5f99"/><circle cx="12.5" cy="12.5" r="5" fill="#fff"/></svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
let homeDrawn = false;

function drawHome(home) {
  if (homeDrawn) return;
  homeDrawn = true;
  L.marker([home.lat, home.lon], { icon: PIN_ICON }).addTo(map);
  const circle = L.circle([home.lat, home.lon], { radius: home.radiusMiles * 1609.34, color: '#1f7a4d', weight: 1, fillOpacity: 0.06 }).addTo(map);
  map.fitBounds(circle.getBounds(), { padding: [10, 10] });
}

// ---------- saved results from the server ----------
let pollTimer = null;
let wasScanning = false;

async function load() {
  clearTimeout(pollTimer);
  let d;
  try {
    d = await fetch('/api/results').then((x) => x.json());
  } catch {
    status('Could not reach the server. Retrying…');
    pollTimer = setTimeout(load, 30_000);
    return;
  }
  $('homeName').textContent = d.home.name;
  $('homeArea').textContent = `Within ${d.home.radiusMiles} miles · checked every ${d.everyHours} hours`;
  drawHome(d.home);

  const fresh = !state.businesses.size || wasScanning || d.lastScan?.finishedAt !== state.lastFinished;
  state.lastFinished = d.lastScan?.finishedAt;
  if (fresh) applyData(d.businesses);

  const s = d.scanning;
  $('scanBtn').disabled = !!s;
  $('progress').hidden = !s;
  if (s) {
    $('bar').style.width = s.total ? `${(100 * s.done) / s.total}%` : '5%';
    status(s.total ? `Checking websites now: ${s.done} of ${s.total}. Saved jobs are shown below.` : s.message);
  } else if (d.lastScan?.finishedAt) {
    const err = d.lastScan.error && Date.parse(d.lastScan.failedAt) > Date.parse(d.lastScan.finishedAt) ? ' Last check failed; will retry soon.' : '';
    status(`Updated ${ago(d.lastScan.finishedAt)} · ${d.lastScan.checked} websites checked.${err}`);
  } else {
    status(d.lastScan?.error ? `First check failed (${d.lastScan.error}). Retrying soon.` : 'First check starting. Jobs will appear here in a few minutes.');
  }
  wasScanning = !!s;
  pollTimer = setTimeout(load, s ? 10_000 : 5 * 60_000);
}

function applyData(list) {
  state.businesses.clear();
  state.results.clear();
  state.jobs = [];
  markers.clearLayers();
  markerById.clear();
  for (const b of list) {
    state.businesses.set(b.id, b);
    if (!b.website) continue; // no-website businesses only appear in Leads
    addMarker(b);
    if (!b.result) continue;
    state.results.set(b.id, b.result);
    for (const j of b.result.jobs) state.jobs.push({ ...j, businessId: b.id, key: `${b.id}|${j.title}` });
    updateMarker(b, b.result);
  }
  for (const b of list) if (!b.website) state.results.set(b.id, b.result || { status: 'no-website', jobs: [] });
  render();
}

$('scanBtn').addEventListener('click', async () => {
  $('scanBtn').disabled = true;
  const r = await fetch('/api/scan', { method: 'POST' }).then((x) => x.json()).catch(() => ({ error: 'Could not reach the server.' }));
  if (r.error) { status(r.error); $('scanBtn').disabled = false; return; }
  wasScanning = true;
  load();
});

function status(msg) { $('status').textContent = msg; }

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr${h > 1 ? 's' : ''} ago` : `${Math.round(h / 24)} days ago`;
}
const NEW_DAYS = 3;
const isNew = (j) => j.firstSeen && Date.now() - Date.parse(j.firstSeen) < NEW_DAYS * 86_400_000;

// ---------- markers ----------
const markerById = new Map();
function addMarker(b) {
  const m = L.circleMarker([b.lat, b.lon], { radius: 5, color: '#9aa39d', weight: 1, fillOpacity: 0.7 });
  m.bindPopup(() => popupHtml(b));
  m.addTo(markers);
  markerById.set(b.id, m);
}
function updateMarker(b, r) {
  const m = markerById.get(b?.id);
  if (!m) return;
  const color = r.status === 'jobs' ? '#1f7a4d' : r.status === 'hiring-page' ? '#c26a12' : '#9aa39d';
  m.setStyle({ color, fillColor: color, radius: r.status === 'jobs' ? 8 : r.status === 'hiring-page' ? 6 : 4 });
  if (r.status === 'jobs') m.bringToFront();
}
function popupHtml(b) {
  const r = state.results.get(b.id);
  const jobs = r?.jobs?.length ? `<br><b>${r.jobs.length} job${r.jobs.length > 1 ? 's' : ''}:</b> ${r.jobs.slice(0, 4).map((j) => esc(j.title)).join(', ')}` : '';
  const note = r?.note ? `<br><i>${esc(r.note)}</i>` : r ? '' : '<br><i>Not checked yet</i>';
  const link = safeUrl(r?.careersUrl || b.website);
  return `<b>${esc(b.name)}</b><br>${esc(b.category)} · ${b.distance} mi${jobs}${note}${link ? `<br><a href="${link}" target="_blank" rel="noopener">Open website</a>` : ''}`;
}

// ---------- results ----------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 250);
}

function leads() {
  const out = [];
  for (const [id, r] of state.results) {
    if (r.status === 'hiring-page' || (r.status === 'no-website' && $('noWebsite').checked)) out.push({ b: state.businesses.get(id), r });
  }
  return out;
}

function payOf(j) { return j.pay || j.estimatedPay; }

function render() {
  const floor = parseFloat($('floor').value) || 0;
  applyEstimates(state.jobs, { wageFloor: floor });
  const kw = $('keyword').value.trim().toLowerCase();
  const onlyListed = $('onlyListed').checked;
  const sort = $('sort').value;
  const match = (j, b) => !kw || [j.title, b.name, b.category, formatHours(j.hours || j.estimatedHours), j.snippet].join(' ').toLowerCase().includes(kw);

  const hideMaybe = $('hideMaybe').checked;
  let jobs = state.jobs.filter((j) => match(j, state.businesses.get(j.businessId)) && (!onlyListed || j.pay) && (!hideMaybe || !j.maybe));
  const savedJobs = Object.values(state.saved);
  const ls = leads().filter(({ b }) => !kw || `${b.name} ${b.category}`.toLowerCase().includes(kw));

  const sorter = {
    new: (a, b) => (Date.parse(b.firstSeen || 0) - Date.parse(a.firstSeen || 0)) || (dist(a) - dist(b)),
    distance: (a, b) => (dist(a) - dist(b)),
    pay: (a, b) => ((payOf(b)?.hourlyMax || 0) - (payOf(a)?.hourlyMax || 0)),
    name: (a, b) => biz(a).name.localeCompare(biz(b).name),
  }[sort];
  jobs.sort(sorter);

  $('nJobs').textContent = jobs.length;
  $('nLeads').textContent = ls.length;
  $('nSaved').textContent = savedJobs.length;

  const list = $('list');
  if (state.tab === 'jobs') {
    list.innerHTML = jobs.length ? jobs.map((j) => jobCard(j, biz(j))).join('')
      : `<p class="empty">${state.results.size ? 'No jobs match. Check the Leads tab for businesses with hiring pages.' : 'No saved jobs yet. The first check runs automatically.'}</p>`;
  } else if (state.tab === 'leads') {
    ls.sort((a, b) => a.b.distance - b.b.distance);
    list.innerHTML = ls.length ? ls.map(({ b, r }) => leadCard(b, r)).join('') : '<p class="empty">No leads yet. Leads are businesses with a careers page or "now hiring" notice where openings couldn\'t be read automatically.</p>';
  } else {
    list.innerHTML = savedJobs.length ? savedJobs.map((s) => jobCard(s.job, s.biz)).join('') : '<p class="empty">Tap ☆ on a job to save it here.</p>';
  }
}

const biz = (j) => state.businesses.get(j.businessId) || state.saved[j.key]?.biz || { name: '', distance: 0 };
const dist = (j) => biz(j).distance ?? 0;

function jobCard(j, b) {
  const pay = j.pay ? `<div class="pay">${esc(formatPay(j.pay))}</div>`
    : j.estimatedPay ? `<div class="pay est">${esc(formatPay(j.estimatedPay))}<span class="badge">EST.</span></div><div class="basis">Estimate: ${esc(j.estimatedPay.basis)}</div>`
      : '';
  const hrs = j.hours?.types?.length || j.hours?.perWeek || j.hours?.schedule?.length
    ? `<div class="hours">🕒 ${esc(formatHours(j.hours))}</div>`
    : j.estimatedHours ? `<div class="hours est">🕒 ${esc(j.estimatedHours.text)}<span class="badge">EST.</span></div>` : '';
  const url = safeUrl(j.url);
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.name} ${b.address || ''}`)}${b.lat ? `&center=${b.lat},${b.lon}` : ''}`;
  const on = !!state.saved[j.key];
  return `<article class="card">
    <h3><span>${esc(j.title)}${isNew(j) ? '<span class="new">NEW</span>' : ''}${j.maybe ? '<span class="maybe">MAYBE</span>' : ''}</span><button class="star ${on ? 'on' : ''}" data-key="${esc(j.key)}" aria-label="Save job">${on ? '★' : '☆'}</button></h3>
    <div class="biz">${esc(b.name)} · ${b.distance ?? '?'} mi · ${esc(b.category || '')}</div>
    ${j.maybe ? `<div class="basis">Might not be an opening: ${esc(j.maybe.toLowerCase())}. Check the link.</div>` : ''}
    ${pay}${hrs}
    ${j.snippet ? `<div class="snippet">${esc(j.snippet)}</div>` : ''}
    <div class="basis">Source: ${esc(j.source || 'Company website')}${j.posted ? ` · posted ${esc(String(j.posted).slice(0, 10))}` : ''}${j.firstSeen ? ` · found ${esc(ago(j.firstSeen))}` : ''}</div>
    <div class="actions">
      ${url ? `<a href="${url}" target="_blank" rel="noopener">View / apply</a>` : ''}
      <a href="${maps}" target="_blank" rel="noopener">Directions</a>
      ${b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
    </div>
  </article>`;
}

function leadCard(b, r) {
  const url = safeUrl(r.careersUrl || b.website);
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.name} ${b.address || ''}`)}`;
  const note = r.status === 'no-website' ? 'No website listed — call or stop by and ask if they are hiring.' : r.note;
  return `<article class="card">
    <h3><span>${esc(b.name)}</span></h3>
    <div class="biz">${b.distance} mi · ${esc(b.category)}${b.address ? ` · ${esc(b.address)}` : ''}</div>
    <div class="basis">${esc(note || '')}</div>
    <div class="actions">
      ${url ? `<a href="${url}" target="_blank" rel="noopener">${r.careersUrl ? 'Careers page' : 'Website'}</a>` : ''}
      <a href="${maps}" target="_blank" rel="noopener">Directions</a>
      ${b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
    </div>
  </article>`;
}

// ---------- saved jobs ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem('savedJobs') || '{}'); } catch { return {}; }
}
function persistSaved() {
  try { localStorage.setItem('savedJobs', JSON.stringify(state.saved)); } catch { /* storage unavailable */ }
}
$('list').addEventListener('click', (e) => {
  const btn = e.target.closest('.star');
  if (!btn) return;
  const key = btn.dataset.key;
  if (state.saved[key]) delete state.saved[key];
  else {
    const job = state.jobs.find((j) => j.key === key);
    if (job) state.saved[key] = { job: { ...job }, biz: { ...biz(job) } };
  }
  persistSaved();
  render();
});

// ---------- tabs / filters / export ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  state.tab = t.dataset.tab;
  render();
}));
['keyword', 'sort', 'onlyListed', 'hideMaybe', 'floor', 'noWebsite'].forEach((id) => $(id).addEventListener('input', render));

$('csvBtn').addEventListener('click', () => {
  const rows = [['Job title', 'Business', 'Distance (mi)', 'Pay', 'Pay is estimate', 'Hours', 'Hours is estimate', 'Category', 'Address', 'Phone', 'Link']];
  for (const j of state.jobs) {
    const b = biz(j);
    rows.push([j.title, b.name, b.distance, formatPay(payOf(j)), j.pay ? 'no' : 'yes', j.hours?.types?.length ? formatHours(j.hours) : j.estimatedHours?.text || '', j.hours?.types?.length ? 'no' : 'yes', b.category, b.address || '', b.phone || '', j.url || '']);
  }
  for (const { b, r } of leads()) rows.push(['(hiring lead)', b.name, b.distance, '', '', '', '', b.category, b.address || '', b.phone || '', r.careersUrl || b.website || '']);
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'jobs.csv';
  a.click();
});

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? esc(x.href) : ''; } catch { return ''; }
}

render();
load();
