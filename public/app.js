import { applyEstimates, formatPay, formatHours } from '/lib/estimate.js';
import { isMedicalJob } from '/lib/medical.js';

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
  const town = d.home.name.split(',')[0];
  $('fbSearch').href = `https://www.facebook.com/search/posts/?q=${encodeURIComponent(`hiring ${town}`)}`;
  // LinkedIn's distance choices are 5, 10, 25, 50 and 100 miles; 25 covers the area.
  $('liSearch').href = `https://www.linkedin.com/jobs/search/?location=${encodeURIComponent(d.home.name.replace(/, AL$/, ', Alabama'))}&distance=25`;
  $('fbGroups').href = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(`${town} jobs`)}`;
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
  groupCache.clear();
  // The same posting often shows up on every location of a chain: list it once,
  // under the closest one.
  const seen = new Set();
  for (const b of [...list].sort((x, y) => x.distance - y.distance)) {
    state.businesses.set(b.id, b);
    if (!b.website) continue; // no-website businesses only appear in Leads
    addMarker(b);
    if (!b.result) continue;
    let r = b.result;
    // Careers site with openings only in other places: show it as a lead.
    if (r.status === 'jobs' && !r.jobs.some((j) => j.where !== 'away')) {
      r = { ...r, status: 'hiring-page', jobs: [], note: 'Has a careers site, but no openings listed for this area right now.' };
    }
    b.result = r;
    state.results.set(b.id, r);
    for (const j of r.jobs) {
      const same = `${j.title.toLowerCase()}|${j.url || ''}`;
      if (j.where === 'away') continue; // job is somewhere else; never shown
      if (seen.has(same)) continue;
      seen.add(same);
      state.jobs.push({ ...j, businessId: b.id, key: `${b.id}|${j.title}` });
    }
    updateMarker(b, r);
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
  // A business whose only jobs are hidden medical ones looks like "nothing found".
  const st = medicalOff(b) ? 'none' : r.status === 'jobs' && !r.jobs.some((j) => j.where !== 'away' && !medicalOff(b, j)) ? 'none' : r.status;
  const color = st === 'jobs' ? '#1f7a4d' : st === 'hiring-page' ? '#c26a12' : '#9aa39d';
  m.setStyle({ color, fillColor: color, radius: st === 'jobs' ? 8 : st === 'hiring-page' ? 6 : 4 });
  if (st === 'jobs') m.bringToFront();
}
function popupHtml(b) {
  const r = state.results.get(b.id);
  const here = (r?.jobs || []).filter((j) => j.where !== 'away' && !medicalOff(b, j));
  const jobs = here.length ? `<br><b>${here.length} job${here.length > 1 ? 's' : ''}:</b> ${here.slice(0, 4).map((j) => esc(j.title)).join(', ')}` : '';
  const note = medicalOff(b) ? '<br><i>Medical jobs are hidden (see "Hide medical jobs").</i>'
    : r?.note ? `<br><i>${esc(r.note)}</i>` : r ? '' : '<br><i>Not checked yet</i>';
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

// Fast food: the map's own "fast food" label, plus common chains that are
// sometimes labeled as a regular restaurant.
const FAST_FOOD_CHAINS = /\b(mcdonald|burger king|wendy|sonic|taco bell|kfc|kentucky fried|chick-fil-a|zaxby|arby|hardee|jack's|subway|popeyes|dairy queen|\bdq\b|captain d|krystal|checkers|rally's|pizza hut|domino|papa john|little caesar|little caesars|marco's pizza|hungry howie|bojangles|church's|long john silver|whataburger|five guys|jimmy john|firehouse subs|jersey mike|wingstop|panda express|chipotle|moe's|taco casa|del taco|starbucks|dunkin|krispy kreme|huddle house|waffle house)/i;
const FAST_FOOD_LIGHT = /\b(huddle house|waffle house)/i; // diners: only hidden when labeled fast food
function isFastFood(b) {
  if (!b) return false;
  if (/fast food/i.test(b.category || '')) return true;
  const name = `${b.name || ''} ${b.brand || ''}`;
  return FAST_FOOD_CHAINS.test(name) && !FAST_FOOD_LIGHT.test(name);
}

// Business categories for the filter buttons, checked in this order.
const GROUPS = [
  ['fast', 'Fast food', (b, c) => isFastFood(b)],
  ['food', 'Restaurants & cafes', (b, c) => /amenity: (restaurant|cafe|bar|pub|ice cream|food court|biergarten)/.test(c)],
  ['health', 'Healthcare', (b, c) => /^healthcare|amenity: (hospital|clinic|doctors|dentist|pharmacy|veterinary|nursing home|social facility)|shop: (chemist|optician|medical supply|hearing aids)/.test(c)],
  ['public', 'Schools & government', (b, c) => /amenity: (school|college|university|kindergarten|childcare|library|post office|townhall|courthouse|police|fire station|community centre)|office: government/.test(c) || /post office|school|college|county|city of/i.test(b.name || '')],
  ['lodging', 'Hotels & camps', (b, c) => /tourism: (hotel|motel|guest house|camp site|caravan site|hostel|chalet|apartment)|leisure: (summer camp|resort)/.test(c) || /\bcamp\b/i.test(b.name || '')],
  ['auto', 'Auto', (b, c) => /shop: (car|car repair|car parts|tyres|motorcycle)|amenity: (fuel|car wash|car rental)/.test(c)],
  ['stores', 'Stores', (b, c) => /^shop:/.test(c)],
  ['other', 'Other', () => true],
];
const groupCache = new Map();
function groupOf(b) {
  if (!b) return 'other';
  if (!groupCache.has(b.id)) {
    const c = (b.category || '').toLowerCase();
    groupCache.set(b.id, GROUPS.find(([, , test]) => test(b, c))[0]);
  }
  return groupCache.get(b.id);
}
const hiddenGroups = new Set(loadHiddenGroups());
function loadHiddenGroups() {
  try { return JSON.parse(localStorage.getItem('hiddenGroups') || '[]'); } catch { return []; }
}
const shown = (b) => !hiddenGroups.has(groupOf(b)) && !medicalOff(b);

// "Hide medical jobs": on unless the user turned it off on this device.
function loadHideMedical() {
  try { return localStorage.getItem('hideMedical') !== 'no'; } catch { return true; }
}
$('hideMedical').checked = loadHideMedical();
// True when this business (or, with a job, that job) is hidden by the setting.
// Every Healthcare-category business counts, plus medical job titles anywhere.
function medicalOff(b, j) {
  if (!$('hideMedical').checked) return false;
  return groupOf(b) === 'health' || (!!j && isMedicalJob(j));
}
$('hideMedical').addEventListener('change', () => {
  try { localStorage.setItem('hideMedical', $('hideMedical').checked ? 'yes' : 'no'); } catch { /* storage unavailable */ }
  for (const [id, r] of state.results) updateMarker(state.businesses.get(id), r);
  render();
});

function renderGroups(jobs) {
  const counts = new Map();
  for (const j of jobs) {
    const g = groupOf(state.businesses.get(j.businessId));
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const medOff = $('hideMedical').checked;
  $('groups').innerHTML = GROUPS.filter(([key]) => (counts.has(key) || hiddenGroups.has(key)) && !(medOff && key === 'health')).map(([key, label]) => {
    const on = !hiddenGroups.has(key);
    return `<button type="button" class="chip ${on ? 'on' : ''}" data-group="${key}" aria-pressed="${on}">${esc(label)} <span>${counts.get(key) || 0}</span></button>`;
  }).join('');
}
$('groups').addEventListener('click', (e) => {
  const key = e.target.closest('.chip')?.dataset.group;
  if (!key) return;
  if (hiddenGroups.has(key)) hiddenGroups.delete(key); else hiddenGroups.add(key);
  try { localStorage.setItem('hiddenGroups', JSON.stringify([...hiddenGroups])); } catch { /* storage unavailable */ }
  render();
});

function leads() {
  const out = [];
  for (const [id, r] of state.results) {
    const b = state.businesses.get(id);
    if (!shown(b)) continue;
    if (r.status === 'hiring-page' || (r.status === 'no-website' && $('noWebsite').checked)) out.push({ b, r });
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
  const candidates = state.jobs.filter((j) => {
    const b = state.businesses.get(j.businessId);
    return match(j, b) && (!onlyListed || j.pay) && (!hideMaybe || !j.maybe) && !medicalOff(b, j);
  });
  renderGroups(candidates);
  let jobs = candidates.filter((j) => shown(state.businesses.get(j.businessId)));
  const savedJobs = Object.values(state.saved);
  const ls = leads().filter(({ b }) => !kw || `${b.name} ${b.category}`.toLowerCase().includes(kw));

  const sorter = {
    new: (a, b) => (Date.parse(b.firstSeen || 0) - Date.parse(a.firstSeen || 0)) || (dist(a) - dist(b)),
    distance: (a, b) => (dist(a) - dist(b)),
    pay: (a, b) => ((payOf(b)?.hourlyMax || 0) - (payOf(a)?.hourlyMax || 0)),
    name: (a, b) => biz(a).name.localeCompare(biz(b).name),
    // Order inside each company; the companies themselves are ordered in companySections().
    company: (a, b) => (!!a.maybe - !!b.maybe) || a.title.localeCompare(b.title),
  }[sort];
  jobs.sort(sorter);

  $('nJobs').textContent = jobs.length;
  $('nLeads').textContent = ls.length;
  $('nSaved').textContent = savedJobs.length;

  const list = $('list');
  if (state.tab === 'jobs') {
    list.innerHTML = !jobs.length ? `<p class="empty">${state.results.size ? 'No jobs match. Check the Leads tab for businesses with hiring pages.' : 'No saved jobs yet. The first check runs automatically.'}</p>`
      : sort === 'company' ? companySections(jobs)
        : jobs.map((j) => jobCard(j, biz(j))).join('');
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
  const r = null;
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
    ${j.location ? `<div class="basis">📍 ${esc(j.location)}</div>` : ''}
    ${j.maybe ? `<div class="basis">Might not be an opening: ${esc(j.maybe.toLowerCase())}. Check the link.</div>` : ''}
    ${pay}${hrs}
    ${j.snippet ? `<div class="snippet">${esc(j.snippet)}</div>` : ''}
    <div class="basis">Source: ${esc(j.source || 'Company website')}${j.posted ? ` · posted ${esc(String(j.posted).slice(0, 10))}` : ''}${j.firstSeen ? ` · found ${esc(ago(j.firstSeen))}` : ''}</div>
    <div class="actions">
      ${url ? `<a href="${url}" target="_blank" rel="noopener">View / apply</a>` : ''}
      <a href="${maps}" target="_blank" rel="noopener">Directions</a>
      ${b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
      ${safeUrl(b.facebook) && safeUrl(b.facebook) !== safeUrl(r?.careersUrl || b.website) ? `<a href="${safeUrl(b.facebook)}" target="_blank" rel="noopener">Facebook</a>` : ''}
    </div>
  </article>`;
}

// ---------- grouped by company ----------
const companyOf = (b) => (b.brand || b.name || '').trim();
const collapsed = new Set(loadCollapsed());
function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem('collapsedCompanies') || '[]'); } catch { return []; }
}

// One section per company (all locations of a brand together), most jobs first, then A–Z.
// `jobs` is already in the order wanted inside each company.
function companySections(jobs) {
  const byCompany = new Map();
  for (const j of jobs) {
    const name = companyOf(biz(j));
    if (!byCompany.has(name)) byCompany.set(name, []);
    byCompany.get(name).push(j);
  }
  return [...byCompany].sort(([a, x], [b, y]) => (y.length - x.length) || a.localeCompare(b)).map(([name, list]) => {
    const places = [...new Set(list.map(biz))].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    const near = places[0];
    const where = places.length > 1 ? `${places.length} locations · closest ${near.distance ?? '?'} mi` : `${near.distance ?? '?'} mi`;
    const open = !collapsed.has(name);
    return `<section class="company">
    <button type="button" class="co-head" data-company="${esc(name)}" aria-expanded="${open}">
      <span class="co-name">${esc(name)}</span>
      <span class="co-count">${list.length} job${list.length > 1 ? 's' : ''}</span>
      <span class="co-meta">${esc(where)}${near.category ? ` · ${esc(near.category)}` : ''}</span>
    </button>
    ${open ? `<div class="co-jobs">${list.map((j) => jobCard(j, biz(j))).join('')}</div>` : ''}
  </section>`;
  }).join('');
}

function leadCard(b, r) {
  const url = safeUrl(r.careersUrl || b.website);
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.name} ${b.address || ''}`)}`;
  const note = r.status === 'no-website'
    ? (b.facebook ? 'No website listed. Check their Facebook page, or call or stop by and ask if they are hiring.' : 'No website listed — call or stop by and ask if they are hiring.')
    : r.note;
  return `<article class="card">
    <h3><span>${esc(b.name)}</span></h3>
    <div class="biz">${b.distance} mi · ${esc(b.category)}${b.address ? ` · ${esc(b.address)}` : ''}</div>
    <div class="basis">${esc(note || '')}</div>
    <div class="actions">
      ${url ? `<a href="${url}" target="_blank" rel="noopener">${/facebook\.com/i.test(url) ? 'Facebook page' : r.careersUrl ? 'Careers page' : 'Website'}</a>` : ''}
      <a href="${maps}" target="_blank" rel="noopener">Directions</a>
      ${b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
      ${safeUrl(b.facebook) && safeUrl(b.facebook) !== safeUrl(r?.careersUrl || b.website) ? `<a href="${safeUrl(b.facebook)}" target="_blank" rel="noopener">Facebook</a>` : ''}
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
  const head = e.target.closest('.co-head');
  if (head) {
    const name = head.dataset.company;
    if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
    try { localStorage.setItem('collapsedCompanies', JSON.stringify([...collapsed])); } catch { /* storage unavailable */ }
    render();
    return;
  }
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
    if (medicalOff(b, j)) continue;
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
