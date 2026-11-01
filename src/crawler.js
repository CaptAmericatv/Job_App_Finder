// Visits a business website, finds its careers / jobs page, and reads the openings.

import * as cheerio from 'cheerio';
import { parsePay, parseHours, jobsFromJsonLd, stripHtml, clean, normalizePay } from './extract.js';
import { ROLES } from './estimate.js';

const UA = 'Mozilla/5.0 (compatible; JobAppFinder/1.0; personal job search)';
const TIMEOUT_MS = +process.env.FETCH_TIMEOUT_MS || 10_000;
const MAX_BYTES = 2_500_000;
const MAX_FETCHES_PER_SITE = +process.env.MAX_FETCHES_PER_SITE || 10;

const CAREER_TEXT = /\b(careers?|jobs?|employment|hiring|join (?:our|the) team|work (?:with|for) us|opportunit(?:y|ies)|openings?|positions?|apply now|now hiring|job application|team up)\b/i;
const CAREER_HREF = /(career|jobs?\b|jobs\/|employment|hiring|join-?(?:our|the)?-?team|work-?(?:with|for)-?us|opportunit|openings|positions|apply|application)/i;
const NOT_CAREER = /\b(student|scholarship|blog|news|press|investor|privacy|terms|cookie|login|sign ?in|cart|donat|volunteer)\b/i;
const HIRING_SIGNAL = /\b(now hiring|we(?:'|’)?re hiring|we are hiring|help wanted|join our team|accepting applications|apply today|currently hiring|hiring now)\b/i;
const GUESS_PATHS = ['/careers', '/jobs', '/employment', '/join-our-team', '/careers.html', '/hiring', '/work-with-us'];

// Job boards (ATS) that small and mid-sized businesses use.
const ATS = [
  { type: 'greenhouse', label: 'Greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i },
  { type: 'greenhouse', label: 'Greenhouse', re: /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/i },
  { type: 'lever', label: 'Lever', re: /jobs\.lever\.co\/([\w.-]+)/i },
  { type: 'ashby', label: 'Ashby', re: /jobs\.ashbyhq\.com\/([\w.-]+)/i },
  { type: 'workable', label: 'Workable', re: /apply\.workable\.com\/([\w-]+)/i },
  { type: 'smartrecruiters', label: 'SmartRecruiters', re: /(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i },
  { type: 'recruitee', label: 'Recruitee', re: /\/\/([\w-]+)\.recruitee\.com/i },
  { type: 'breezy', label: 'Breezy HR', re: /\/\/([\w-]+)\.breezy\.hr/i },
  { type: 'bamboohr', label: 'BambooHR', re: /\/\/([\w-]+)\.bamboohr\.com/i },
  // Link-only boards (no public feed): we point you to them.
  { type: 'link', label: 'Workday', re: /[\w-]+\.myworkdayjobs\.com[^\s"'<>]*/i },
  { type: 'link', label: 'iCIMS', re: /[\w-]+\.icims\.com[^\s"'<>]*/i },
  { type: 'link', label: 'Paylocity', re: /recruiting\.paylocity\.com[^\s"'<>]*/i },
  { type: 'link', label: 'ADP', re: /workforcenow\.adp\.com[^\s"'<>]*|myjobs\.adp\.com[^\s"'<>]*/i },
  { type: 'link', label: 'UKG', re: /recruiting\d*\.ultipro\.com[^\s"'<>]*|[\w-]+\.rec\.pro\.ukg\.net[^\s"'<>]*/i },
  { type: 'link', label: 'Jobvite', re: /jobs\.jobvite\.com[^\s"'<>]*/i },
  { type: 'link', label: 'JazzHR', re: /[\w-]+\.applytojob\.com[^\s"'<>]*/i },
  { type: 'link', label: 'Paycom', re: /paycomonline\.net[^\s"'<>]*/i },
  { type: 'link', label: 'Dayforce', re: /jobs\.dayforcehcm\.com[^\s"'<>]*/i },
  { type: 'link', label: 'Taleo', re: /[\w-]+\.taleo\.net[^\s"'<>]*/i },
  { type: 'link', label: 'Harri', re: /harri\.com\/[^\s"'<>]+/i },
  { type: 'link', label: 'Workstream', re: /workstream\.(?:us|is)\/[^\s"'<>]+/i },
  { type: 'link', label: 'Fountain', re: /[\w-]+\.fountain\.com\/[^\s"'<>]+|jobs\.fountain\.com[^\s"'<>]*/i },
  { type: 'link', label: 'Hireology', re: /careers\.hireology\.com[^\s"'<>]*/i },
  { type: 'link', label: 'Indeed', re: /indeed\.com\/(?:cmp|job|viewjob)[^\s"'<>]*/i },
];

// Role words must start a word, so "coworkers" doesn't count as "worker".
const ROLE_WORDS = new RegExp(
  '\\b(?:' + ROLES.map((r) => r[2].source).join('|') +
  '|attendant|operator|specialist|assistant|representative|coordinator|crew|staff|worker|agent|advisor|consultant|groomer|bather|trainer|cleaner|runner|bagger|picker)',
  'i',
);
// Headings on careers pages that aren't openings ("Team Member Careers", "Life at X").
const HEADING_NOT_JOB = /(\bjob description\b|\bpositions$|\bopenings\b)|\b(careers?|opportunities|benefits|culture|life at|why (work|join)|our (people|team|values|story)|current (team members|employees)|co-?workers|testimonials?|perks)\b/i;
const NOT_A_TITLE = /^(careers?|jobs?|apply( now| here| today| online)?|join (our|the) team|employment|open positions|current openings|view (all )?(jobs|openings|positions)|learn more|read more|home|about( us)?|contact( us)?|menu|search|benefits|our team|meet the team|faq|locations?)$/i;

// ---------------- fetching ----------------

const robotsCache = new Map();

async function fetchText(url, { accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const type = res.headers.get('content-type') || '';
  if (!/html|json|xml|text/i.test(type)) return { status: res.status, url: res.url, text: '' };
  const reader = res.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      text += decoder.decode(value, { stream: true });
      if (total > MAX_BYTES) { reader.cancel().catch(() => {}); break; }
    }
  }
  return { status: res.status, url: res.url || url, text };
}

async function fetchJson(url) {
  const r = await fetchText(url, { accept: 'application/json' });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.text);
}

// Respect robots.txt "Disallow" rules for all crawlers.
async function robotsAllows(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return false; }
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const r = await fetchText(`${origin}/robots.txt`, { accept: 'text/plain' });
        return r.status < 400 ? parseRobots(r.text) : [];
      } catch { return []; }
    })());
  }
  const rules = await robotsCache.get(origin);
  const u = new URL(url);
  return robotsAllowsPath(rules, u.pathname + u.search);
}

// Longest matching rule wins; Allow wins a tie (Google's rules).
export function robotsAllowsPath(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
  }
  return !best || best.allow;
}

// Rules that apply to us: {allow, re, len}. Supports * and $ wildcards.
export function parseRobots(text) {
  const rules = [];
  let applies = false;
  let sawAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const [k, ...rest] = line.split(':');
    const key = (k || '').trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!sawAgent) applies = false;
      sawAgent = true;
      if (val === '*' || /jobappfinder/i.test(val)) applies = true;
    } else if (key) {
      sawAgent = false;
      if (applies && (key === 'disallow' || key === 'allow') && val) {
        const anchored = val.endsWith('$');
        const body = (anchored ? val.slice(0, -1) : val).split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        rules.push({ allow: key === 'allow', re: new RegExp('^' + body + (anchored ? '$' : '')), len: val.length });
      }
    }
  }
  return rules;
}

// ---------------- page parsing ----------------

function absolute(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

function siteKey(url) {
  const parts = new URL(url).hostname.toLowerCase().split('.');
  // example.co.uk keeps three parts; example.com keeps two.
  const n = parts.length > 2 && parts.at(-1).length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
}

function sameSite(a, b) {
  try { return siteKey(a) === siteKey(b); } catch { return false; }
}

export function detectAts(text) {
  const found = [];
  const seen = new Set();
  for (const a of ATS) {
    const m = String(text).match(a.re);
    if (!m) continue;
    const key = a.type === 'link' ? a.label : `${a.type}:${m[1].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.type !== 'link' && ['www', 'api', 'app', 'embed', 'help', 'support'].includes(m[1].toLowerCase())) continue;
    found.push({ type: a.type, label: a.label, token: a.type === 'link' ? null : m[1], url: a.type === 'link' ? `https://${m[0]}` : null });
  }
  return found;
}

export function findCareerLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = clean($(el).text() || $(el).attr('title') || $(el).attr('aria-label'));
    const url = absolute(href, baseUrl);
    if (!url) return;
    if (NOT_CAREER.test(text) || NOT_CAREER.test(href)) return;
    const textHit = CAREER_TEXT.test(text) && text.length < 50;
    const hrefHit = CAREER_HREF.test(new URL(url).pathname + new URL(url).hostname);
    const atsHit = detectAts(url).length > 0;
    if (textHit || hrefHit || atsHit) {
      const score = (textHit ? 2 : 0) + (hrefHit ? 2 : 0) + (atsHit ? 3 : 0) + (/career|jobs|employment/i.test(text + href) ? 1 : 0);
      links.push({ url, text, score, external: !sameSite(url, baseUrl), ats: atsHit });
    }
  });
  const best = new Map();
  for (const l of links) if (!best.has(l.url) || best.get(l.url).score < l.score) best.set(l.url, l);
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function blockText($, el) {
  let node = $(el);
  for (let i = 0; i < 6; i++) {
    const parent = node.parent();
    if (!parent.length) break;
    const len = clean(parent.text()).length;
    if (len > 1500) break;
    // Stop before swallowing a neighboring job listing.
    if (parent.find(el.tagName).length > 1) break;
    node = parent;
    if (len > 120 && /^(li|article|section|tr|div)$/i.test(parent[0].tagName)) break;
  }
  // Include text right after a heading (job descriptions often follow it).
  let text = stripHtml($.html(node));
  if (/^h\d$/i.test(node[0]?.tagName)) {
    let sib = node.next();
    for (let i = 0; i < 8 && sib.length && !/^h\d$/i.test(sib[0].tagName); i++) {
      text += ' ' + stripHtml($.html(sib));
      sib = sib.next();
    }
  }
  return text.replace(/\s+/g, ' ').slice(0, 1500);
}

// Look for job titles in a careers page's HTML when there's no structured data.
export function jobsFromHtml($, pageUrl) {
  const jobs = [];
  const seen = new Set();
  $('script, style, nav, footer, header, noscript').remove();
  const selector = 'h1, h2, h3, h4, h5, h6, li > a, li > strong, td a, a[class*="job"], [class*="job-title"], [class*="jobTitle"], [class*="position"] , dt, strong, b';
  $(selector).each((_, el) => {
    const title = clean($(el).text());
    if (title.length < 3 || title.length > 70) return;
    if (NOT_A_TITLE.test(title)) return; // plain navigation: "Careers", "Apply now"
    const link = $(el).is('a') ? $(el).attr('href') : $(el).find('a[href]').attr('href') || $(el).closest('a[href]').attr('href');
    // Nothing else is dropped: anything that might be an opening is kept, and
    // the doubtful ones are marked "maybe" so the page can label them.
    let maybe = null;
    if (!ROLE_WORDS.test(title)) {
      // No job word in it: keep only when the page marks it up or links it like a job.
      const cls = `${$(el).attr('class') || ''} ${$(el).parent().attr('class') || ''}`;
      if (!/job|position|opening|vacanc|posting/i.test(cls) && !/job|position|opening|vacanc|posting|apply/i.test(link || '')) return;
      maybe = 'No job title words';
    } else if (HEADING_NOT_JOB.test(title) || /^Support [A-Z]{2,}$/.test(title)) maybe = 'Looks like a page heading';
    else if ((/[.!?]$/.test(title) && title.split(' ').length > 6) || /[?!®™]|\(video\)|\bprograms?\b/i.test(title) || title.split(/\s+/).length > 8) maybe = 'Looks like marketing text';
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const context = blockText($, el);
    jobs.push({
      title,
      url: absolute(link, pageUrl) || pageUrl,
      pay: parsePay(context),
      hours: parseHours(context),
      snippet: context.slice(0, 300),
      detailUrl: link && absolute(link, pageUrl) !== pageUrl ? absolute(link, pageUrl) : null,
      guessed: true,
      maybe,
    });
  });
  return jobs.slice(0, 200);
}

// Page text with spaces between elements (cheerio's .text() glues them together).
function textOf($, sel = 'body') {
  const html = $(sel).html();
  return html ? stripHtml(html).replace(/\s+/g, ' ') : '';
}

function ldBlocks($) {
  return $('script[type="application/ld+json"]').map((_, el) => $(el).contents().text()).get();
}

// ---------------- job board feeds ----------------

const LEVER_UNITS = { 'per-hour-wage': 'hour', 'per-year-salary': 'year', 'per-month-salary': 'month', 'per-week-salary': 'week', 'per-day-wage': 'day', 'one-time': null };

function fromText(title, url, text, extra = {}) {
  return { title: clean(title), url, pay: extra.pay || parsePay(text), hours: extra.hours || parseHours(text), snippet: clean(text).slice(0, 300) };
}

export async function fetchAtsJobs(ats) {
  const t = ats.token;
  switch (ats.type) {
    case 'greenhouse': {
      const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`);
      return (d.jobs || []).map((j) => fromText(j.title, j.absolute_url, `${j.location?.name || ''} ${stripHtml(stripHtml(j.content || ''))}`));
    }
    case 'lever': {
      const d = await fetchJson(`https://api.lever.co/v0/postings/${t}?mode=json`);
      return (d || []).map((j) => {
        const sr = j.salaryRange;
        const pay = sr ? normalizePay(sr.min, sr.max, LEVER_UNITS[sr.interval], 'listed salary') : null;
        const text = `${j.categories?.commitment || ''} ${j.descriptionPlain || ''} ${(j.lists || []).map((l) => stripHtml(l.content)).join(' ')} ${j.additionalPlain || ''}`;
        return fromText(j.text, j.hostedUrl, text, { pay });
      });
    }
    case 'ashby': {
      const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`);
      return (d.jobs || []).map((j) => fromText(j.title, j.jobUrl, `${j.employmentType || ''} ${j.compensation?.compensationTierSummary || ''} ${j.descriptionPlain || ''}`));
    }
    case 'workable': {
      const d = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${t}`);
      return (d.jobs || []).map((j) => fromText(j.title, j.url || j.shortlink || `https://apply.workable.com/${t}/`, `${j.employment_type || ''} ${stripHtml(j.description || '')}`));
    }
    case 'smartrecruiters': {
      const d = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`);
      return (d.content || []).map((j) => fromText(j.name, `https://jobs.smartrecruiters.com/${t}/${j.id}`, `${j.typeOfEmployment?.label || ''} ${j.experienceLevel?.label || ''}`));
    }
    case 'recruitee': {
      const d = await fetchJson(`https://${t}.recruitee.com/api/offers/`);
      return (d.offers || []).map((j) => {
        const s = j.salary;
        const pay = s && (s.min || s.max) ? normalizePay(+s.min || null, +s.max || null, { hour: 'hour', year: 'year', month: 'month', week: 'week' }[s.period], 'listed salary') : null;
        const hours = j.min_hours || j.max_hours ? { types: [], perWeek: { min: +j.min_hours || +j.max_hours, max: +j.max_hours || +j.min_hours }, schedule: [], source: 'listed' } : null;
        if (hours) hours.types.push(hours.perWeek.max >= 35 ? 'Full-time' : 'Part-time');
        return fromText(j.title, j.careers_url, `${j.employment_type_code || ''} ${stripHtml(j.description || '')} ${stripHtml(j.requirements || '')}`, { pay, hours });
      });
    }
    case 'breezy': {
      const d = await fetchJson(`https://${t}.breezy.hr/json`);
      return (d || []).map((j) => fromText(j.name, j.url, `${j.type?.name || ''} ${j.salary || ''}`));
    }
    case 'bamboohr': {
      const d = await fetchJson(`https://${t}.bamboohr.com/careers/list`);
      return (d.result || []).map((j) => fromText(j.jobOpeningName, `https://${t}.bamboohr.com/careers/${j.id}`, `${j.employmentStatusLabel || ''}`));
    }
    default:
      return [];
  }
}

// ---------------- main entry ----------------

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

// chain: the business is part of a brand (OSM "brand" tag). Chain career sites are
// national and mostly built with JavaScript, so titles guessed from their headings
// are usually marketing copy; only trust structured job data or job-board feeds there.
export async function crawlBusiness(website, { chain = false } = {}) {
  if (!website) return { status: 'no-website', jobs: [] };
  const key = (chain ? 'chain:' : '') + website.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.result;
  const result = await crawlUncached(website, chain).catch((e) => ({ status: 'error', jobs: [], note: friendlyError(e) }));
  cache.set(key, { time: Date.now(), result });
  return result;
}

function friendlyError(e) {
  const m = String(e?.cause?.code || e?.name || e?.message || e);
  if (/timeout|abort/i.test(m)) return 'Website took too long to respond';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Website address not found';
  if (/CERT|SSL|TLS/i.test(m)) return 'Website has a security certificate problem';
  return `Could not load website (${m.slice(0, 60)})`;
}

async function crawlUncached(website, chain) {
  let fetches = 0;
  const get = async (url) => {
    if (fetches >= MAX_FETCHES_PER_SITE) return null;
    if (!(await robotsAllows(url))) return null;
    fetches++;
    try {
      const r = await fetchText(url);
      return r.status < 400 && r.text ? r : null;
    } catch (e) {
      if (fetches === 1) throw e;
      return null;
    }
  };

  const home = await get(website);
  if (!home) return { status: 'error', jobs: [], note: 'Website could not be loaded' };
  const $home = cheerio.load(home.text);
  const hiringSignal = HIRING_SIGNAL.test(textOf($home));
  const boards = detectAts(home.text);
  let jobs = jobsFromJsonLd(ldBlocks($home), home.url);

  // 1. Candidate careers pages: links on the home page, then common paths.
  const links = findCareerLinks($home, home.url);
  const candidates = links.filter((l) => !l.external || l.ats).slice(0, 5).map((l) => l.url);
  if (!candidates.length) {
    const origin = new URL(home.url).origin;
    for (const p of GUESS_PATHS.slice(0, 4)) candidates.push(origin + p);
  }

  let careersUrl = null;
  for (const url of candidates) {
    if (detectAts(url).some((a) => a.type !== 'link')) {
      boards.push(...detectAts(url));
      careersUrl ||= url;
      continue;
    }
    if (detectAts(url).length) { boards.push(...detectAts(url)); careersUrl ||= url; continue; }
    const page = await get(url);
    if (!page) continue;
    const $ = cheerio.load(page.text);
    const bodyText = textOf($);
    const looksLikeJobs = CAREER_TEXT.test($('title').text() + ' ' + $('h1').text()) || /\b(apply|application|position|resume|hiring)\b/i.test(bodyText);
    if (!looksLikeJobs) continue;
    careersUrl ||= page.url;
    boards.push(...detectAts(page.text));
    let found = jobsFromJsonLd(ldBlocks($), page.url);
    if (!found.length) found = jobsFromHtml($, page.url);
    jobs.push(...found);
    // Careers page may link deeper (e.g. "View openings").
    if (!found.length) {
      const deeper = findCareerLinks($, page.url).filter((l) => l.url !== page.url && !candidates.includes(l.url));
      for (const d of deeper) if (detectAts(d.url).length) boards.push(...detectAts(d.url));
      const inner = deeper.find((l) => !l.external);
      if (inner) {
        const p2 = await get(inner.url);
        if (p2) {
          const $2 = cheerio.load(p2.text);
          boards.push(...detectAts(p2.text));
          let f2 = jobsFromJsonLd(ldBlocks($2), p2.url);
          if (!f2.length) f2 = jobsFromHtml($2, p2.url);
          jobs.push(...f2);
        }
      }
    }
  }

  // 2. Job boards with public feeds.
  const seenBoard = new Set();
  let boardLabel = null;
  for (const b of boards) {
    const key = `${b.type}:${b.token || b.label}`;
    if (seenBoard.has(key)) continue;
    seenBoard.add(key);
    boardLabel ||= b.label;
    if (b.type === 'link') { careersUrl ||= b.url; continue; }
    try {
      const boardJobs = await fetchAtsJobs(b);
      for (const j of boardJobs) j.source = b.label;
      jobs.push(...boardJobs);
    } catch { /* feed unavailable */ }
  }

  // 3. Open job detail pages to find pay/hours that weren't on the list page.
  for (const j of jobs.filter((x) => x.detailUrl && sameSite(x.detailUrl, home.url) && (!x.pay || !x.hours)).slice(0, 5)) {
    const p = await get(j.detailUrl);
    if (!p) continue;
    const $d = cheerio.load(p.text);
    const ld = jobsFromJsonLd(ldBlocks($d), p.url)[0];
    $d('script, style, nav, footer, header').remove();
    const text = textOf($d, 'main') || textOf($d);
    j.pay ||= ld?.pay || parsePay(text);
    j.hours ||= ld?.hours || parseHours(text);
    if (!j.snippet || j.snippet.length < 80) j.snippet = clean(text).slice(0, 300);
  }

  // Chain sites are national; titles read from their headings may not be local openings.
  if (chain) for (const j of jobs) if (j.guessed) j.maybe ||= 'Chain website, may not be this location';

  // Dedupe and tidy.
  const unique = new Map();
  for (const j of jobs) {
    delete j.guessed;
    const k = j.title.toLowerCase();
    if (!unique.has(k)) unique.set(k, { ...j, source: j.source || 'Company website', detailUrl: undefined });
  }
  jobs = [...unique.values()].slice(0, 500);

  if (jobs.length) return { status: 'jobs', jobs, careersUrl: careersUrl || home.url, board: boardLabel };
  if (careersUrl || hiringSignal) {
    return {
      status: 'hiring-page',
      jobs: [],
      careersUrl: careersUrl || home.url,
      board: boardLabel,
      note: careersUrl
        ? `Has a careers page${boardLabel ? ` on ${boardLabel}` : ''} but no openings could be read automatically — open the link to check.`
        : 'Website says they are hiring — check the site or ask in person.',
    };
  }
  return { status: 'none', jobs: [], note: 'No careers page found on website' };
}
