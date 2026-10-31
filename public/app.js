import { applyEstimates, formatPay, formatHours } from '/lib/estimate.js';

const $ = (id) => document.getElementById(id);
const state = {
  center: null,
  businesses: new Map(),
  results: new Map(),
  jobs: [],
  tab: 'jobs',
  source: null,
  saved: loadSaved(),
};

// ---------- map ----------
const map = L.map('map').setView([39.5, -98.35], 4);
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
let centerMarker = null;
let circle = null;

function setCenter(lat, lon, label) {
  state.center = { lat, lon };
  $('locLabel').textContent = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  $('searchBtn').disabled = false;
  if (centerMarker) centerMarker.setLatLng([lat, lon]);
  else centerMarker = L.marker([lat, lon], { icon: PIN_ICON }).addTo(map);
  drawCircle();
  map.fitBounds(circle.getBounds(), { padding: [10, 10] });
}

function drawCircle() {
  if (!state.center) return;
  const meters = +$('radius').value * 1609.34;
  if (circle) circle.setLatLng([state.center.lat, state.center.lon]).setRadius(meters);
  else circle = L.circle([state.center.lat, state.center.lon], { radius: meters, color: '#1f7a4d', weight: 1, fillOpacity: 0.06 }).addTo(map);
}

map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng));
$('radius').addEventListener('input', () => {
  $('radiusOut').textContent = $('radius').value;
  drawCircle();
});
$('radius').addEventListener('change', () => circle && map.fitBounds(circle.getBounds(), { padding: [10, 10] }));

$('locForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('locInput').value.trim();
  if (!q) return;
  status('Looking up address…');
  try {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    if (!r.length) return status('Address not found. Try adding the city and state.');
    setCenter(r[0].lat, r[0].lon, r[0].name);
    status('');
  } catch (err) { status(err.message); }
});

$('gpsBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return status('Location is not available in this browser.');
  status('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (p) => { setCenter(p.coords.latitude, p.coords.longitude, 'Your current location'); status(''); },
    () => status('Could not get your location. Type an address or tap the map instead.'),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---------- search ----------
$('searchBtn').addEventListener('click', startSearch);
$('stopBtn').addEventListener('click', () => stopSearch('Stopped.'));

function startSearch() {
  if (!state.center) return;
  stopSearch();
  state.businesses.clear();
  state.results.clear();
  state.jobs = [];
  markers.clearLayers();
  render();
  const p = new URLSearchParams({
    lat: state.center.lat, lon: state.center.lon, radius: $('radius').value,
    limit: $('limit').value, noWebsite: $('noWebsite').checked ? '1' : '0',
  });
  const es = new EventSource(`/api/search?${p}`);
  state.source = es;
  $('searchBtn').disabled = true;
  $('stopBtn').hidden = false;
  $('progress').hidden = false;
  $('bar').style.width = '0';

  es.addEventListener('status', (e) => status(JSON.parse(e.data).message));
  es.addEventListener('businesses', (e) => {
    const d = JSON.parse(e.data);
    for (const b of d.businesses) { state.businesses.set(b.id, b); addMarker(b); }
    status(d.businesses.length
      ? `Checking ${d.businesses.length} business websites${d.limited ? ` (closest ${d.businesses.length} of ${d.total})` : ''}…`
      : 'No businesses with websites found here. Try a bigger radius.');
    if (!d.businesses.length) stopSearch();
  });
  es.addEventListener('result', (e) => {
    const r = JSON.parse(e.data);
    state.results.set(r.id, r);
    const b = state.businesses.get(r.id);
    for (const j of r.jobs) state.jobs.push({ ...j, businessId: r.id, key: `${r.id}|${j.title}` });
    updateMarker(b, r);
    $('bar').style.width = `${(100 * r.done) / r.total}%`;
    status(`Checked ${r.done} of ${r.total} websites — ${state.jobs.length} jobs so far`);
    scheduleRender();
  });
  es.addEventListener('done', () => stopSearch(`Done. Found ${state.jobs.length} jobs and ${leads().length} hiring leads.`));
  es.addEventListener('fail', (e) => stopSearch(JSON.parse(e.data).error));
  es.onerror = () => { if (state.source) stopSearch('Connection lost. Results so far are shown below.'); };
}

function stopSearch(msg) {
  if (state.source) state.source.close();
  state.source = null;
  $('searchBtn').disabled = !state.center;
  $('stopBtn').hidden = true;
  $('progress').hidden = true;
  if (msg) status(msg);
  render();
}

function status(msg) { $('status').textContent = msg; }

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
  const note = r?.note ? `<br><i>${esc(r.note)}</i>` : r ? '' : '<br><i>Checking…</i>';
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

  let jobs = state.jobs.filter((j) => match(j, state.businesses.get(j.businessId)) && (!onlyListed || j.pay));
  const savedJobs = Object.values(state.saved);
  const ls = leads().filter(({ b }) => !kw || `${b.name} ${b.category}`.toLowerCase().includes(kw));

  const sorter = {
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
      : `<p class="empty">${state.source ? 'Searching… jobs will show up here as they are found.' : state.results.size ? 'No jobs match. Check the Leads tab for businesses with hiring pages.' : 'Pick a location and tap <b>Find jobs</b>.'}</p>`;
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
    <h3><span>${esc(j.title)}</span><button class="star ${on ? 'on' : ''}" data-key="${esc(j.key)}" aria-label="Save job">${on ? '★' : '☆'}</button></h3>
    <div class="biz">${esc(b.name)} · ${b.distance ?? '?'} mi · ${esc(b.category || '')}</div>
    ${pay}${hrs}
    ${j.snippet ? `<div class="snippet">${esc(j.snippet)}</div>` : ''}
    <div class="basis">Source: ${esc(j.source || 'Company website')}${j.posted ? ` · posted ${esc(String(j.posted).slice(0, 10))}` : ''}</div>
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
['keyword', 'sort', 'onlyListed', 'floor'].forEach((id) => $(id).addEventListener('input', render));

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
