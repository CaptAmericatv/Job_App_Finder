// Pull pay and hours info out of free text and structured job data.

const HOURS_PER_YEAR = 2080;
const UNIT_TO_HOURLY = { hour: 1, day: 1 / 8, week: 1 / 40, month: 12 / HOURS_PER_YEAR, year: 1 / HOURS_PER_YEAR };

const UNIT_WORDS = [
  [/^(?:\/|per |an |a |each )?\s*(?:hr|hour|hourly|hrs)\b/i, 'hour'],
  [/^(?:\/|per |a |an )?\s*(?:yr|year|annum|annually|annual)\b/i, 'year'],
  [/^(?:\/|per |a )?\s*(?:wk|week|weekly)\b/i, 'week'],
  [/^(?:\/|per |a )?\s*(?:mo|month|monthly)\b/i, 'month'],
  [/^(?:\/|per |a )?\s*(?:day|daily|shift)\b/i, 'day'],
];

const PAY_CONTEXT = /\b(pay|wage|wages|salary|compensation|starting|start at|earn|rate|hourly|per hour|\/hr|DOE|depending on experience|tips|range)\b/i;

function toNumber(str, kSuffix) {
  let n = parseFloat(String(str).replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  if (kSuffix) n *= 1000;
  return n;
}

function guessUnit(value) {
  if (value >= 15000) return 'year';
  if (value >= 7 && value <= 200) return 'hour';
  return null;
}

function detectUnit(after) {
  const s = after.replace(/^[\s.,)]+/, '').slice(0, 20);
  for (const [re, unit] of UNIT_WORDS) if (re.test(s)) return unit;
  return null;
}

function roundPay(n) {
  return Math.round(n * 100) / 100;
}

export function normalizePay(min, max, unit, text = '', source = 'listed') {
  if (min == null && max == null) return null;
  if (min == null) min = max;
  if (max == null) max = min;
  if (min > max) [min, max] = [max, min];
  unit = unit || guessUnit(min);
  if (!unit) return null;
  const f = UNIT_TO_HOURLY[unit];
  const hourlyMin = roundPay(min * f);
  const hourlyMax = roundPay(max * f);
  // Sanity check: ignore numbers that can't be real wages.
  if (hourlyMin < 5 || hourlyMax > 500) return null;
  return { min, max, unit, hourlyMin, hourlyMax, text: text.trim().slice(0, 120), source };
}

// Find the most likely pay mention in a block of text.
export function parsePay(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');
  const money = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s?(k|K)?`;
  const re = new RegExp(money + String.raw`(?:\s?(?:-|–|—|to)\s?\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s?(k|K)?)?`, 'g');
  const candidates = [];
  let m;
  while ((m = re.exec(t))) {
    const min = toNumber(m[1], m[2]);
    const max = m[3] ? toNumber(m[3], m[4] || (m[2] && !m[4] ? m[2] : null)) : null;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 25);
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    let unit = detectUnit(after);
    const hasContext = PAY_CONTEXT.test(before) || PAY_CONTEXT.test(after);
    if (!unit && !hasContext) continue; // probably a product price
    const pay = normalizePay(min, max, unit, t.slice(Math.max(0, m.index - 10), m.index + m[0].length + 12));
    if (pay) candidates.push({ pay, score: (unit ? 2 : 0) + (hasContext ? 1 : 0) + (max ? 1 : 0) });
  }
  // "15 to 18 dollars an hour" style
  const wordRe = /(\d+(?:\.\d{1,2})?)\s?(?:-|to)?\s?(\d+(?:\.\d{1,2})?)?\s?dollars?\s?(?:an|per|\/)\s?hour/gi;
  while ((m = wordRe.exec(t))) {
    const pay = normalizePay(toNumber(m[1]), m[2] ? toNumber(m[2]) : null, 'hour', m[0]);
    if (pay) candidates.push({ pay, score: 3 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].pay;
}

const TYPE_PATTERNS = [
  [/\bfull[\s-]?time\b|\bFT\b/i, 'Full-time'],
  [/\bpart[\s-]?time\b|\bPT\b/i, 'Part-time'],
  [/\bseasonal\b/i, 'Seasonal'],
  [/\btemporary\b|\btemp\b/i, 'Temporary'],
  [/\bper[\s-]?diem\b|\bPRN\b/, 'Per diem'],
  [/\binternship\b|\bintern\b/i, 'Internship'],
  [/\bcontract(?:or)?\b/i, 'Contract'],
];

const SCHEDULE_PATTERNS = [
  /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s?(?:-|–|through|thru|to)\s?(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i,
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)\s?(?:-|–|to)\s?\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/i,
  /\b(?:overnight|graveyard|night|evening|morning|day|swing|weekend)s?\s+shifts?\b/i,
  /\bweekends?\s+(?:required|needed|only)\b/i,
  /\bflexible\s+(?:schedule|hours|shifts)\b/i,
];

export function parseHours(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');
  const types = [];
  for (const [re, label] of TYPE_PATTERNS) if (re.test(t) && !types.includes(label)) types.push(label);

  let perWeek = null;
  const range = t.match(/(\d{1,2})\s?(?:-|–|to)\s?(\d{1,2})\s?\+?\s?(?:hours|hrs)\s?(?:per|\/|a|each)?\s?(?:week|wk)/i);
  const single = t.match(/(\d{1,2})\s?\+?\s?(?:hours|hrs)\s?(?:per|\/|a|each)\s?(?:week|wk)/i);
  if (range) perWeek = { min: +range[1], max: +range[2] };
  else if (single) perWeek = { min: +single[1], max: +single[1] };
  if (perWeek && (perWeek.max > 80 || perWeek.min < 1)) perWeek = null;

  const schedule = [];
  for (const re of SCHEDULE_PATTERNS) {
    const m = t.match(re);
    if (m) schedule.push(m[0]);
  }
  if (!types.length && !perWeek && !schedule.length) return null;
  if (!types.length && perWeek) types.push(perWeek.max >= 35 ? 'Full-time' : 'Part-time');
  return { types, perWeek, schedule, source: 'listed' };
}

// ---- schema.org JobPosting (JSON-LD) ----

const SCHEMA_UNITS = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const SCHEMA_TYPES = {
  FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary',
  INTERN: 'Internship', PER_DIEM: 'Per diem', SEASONAL: 'Seasonal',
};

export function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function flattenLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
  else if (typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenLd(node['@graph'], out);
    if (node.itemListElement) flattenLd(node.itemListElement, out);
    if (node.item) flattenLd(node.item, out);
  }
  return out;
}

export function jobsFromJsonLd(blocks, pageUrl) {
  const jobs = [];
  for (const raw of blocks) {
    let data;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    for (const node of flattenLd(data)) {
      const type = [].concat(node['@type'] || []);
      if (!type.includes('JobPosting')) continue;
      const description = stripHtml(node.description || '');
      let pay = null;
      const bs = node.baseSalary || node.estimatedSalary;
      const v = bs && (bs.value || bs);
      if (v && typeof v === 'object') {
        const unit = SCHEMA_UNITS[String(v.unitText || bs.unitText || '').toUpperCase()];
        pay = normalizePay(num(v.minValue ?? v.value), num(v.maxValue ?? v.value), unit, 'listed salary');
      } else if (v != null && !Number.isNaN(+v)) {
        pay = normalizePay(+v, +v, null, 'listed salary');
      }
      if (!pay) pay = parsePay(description);
      const hours = parseHours(description) || { types: [], perWeek: null, schedule: [], source: 'listed' };
      const empTypes = [].concat(node.employmentType || []).flatMap((s) => String(s).split(/[,\s]+/));
      for (const e of empTypes) {
        const label = SCHEMA_TYPES[e.toUpperCase()];
        if (label && !hours.types.includes(label)) hours.types.unshift(label);
      }
      if (node.workHours) hours.schedule.push(String(node.workHours));
      jobs.push({
        title: clean(node.title || node.name || 'Job opening'),
        url: node.url || pageUrl,
        pay,
        hours: hours.types.length || hours.perWeek || hours.schedule.length ? hours : null,
        posted: node.datePosted || null,
        snippet: description.slice(0, 300),
        location: ldLocation(node),
      });
    }
  }
  return jobs;
}

// "City, ST" from a JobPosting's jobLocation (or "Remote").
function ldLocation(node) {
  if (/TELECOMMUTE/i.test(String(node.jobLocationType || ''))) return 'Remote';
  const places = [].concat(node.jobLocation || []).map((loc) => {
    const a = loc?.address || loc || {};
    if (typeof a === 'string') return clean(a);
    const country = typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry;
    return [a.addressLocality, a.addressRegion, /^(US|USA|United States)$/i.test(country || '') ? null : country].filter(Boolean).map((x) => clean(String(x))).join(', ');
  }).filter(Boolean);
  return places.length ? [...new Set(places)].join(' / ') : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,$]/g, ''));
  return Number.isNaN(n) ? null : n;
}

export function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}
