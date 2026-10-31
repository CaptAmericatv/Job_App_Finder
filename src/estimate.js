// Fills in pay and hours for jobs where the posting didn't say.
// Runs in both Node and the browser (no imports).
//
// Order of preference:
//   1. Other jobs found in this same search with the same kind of role
//   2. Built-in typical ranges (rough U.S. figures; adjust to your area)

// [role key, label, title keywords, typical hourly [low, high], typical hours]
export const ROLES = [
  ['cashier', 'Cashier', /cashier|checkout|front end|teller/i, [12, 16], 'Part-time or full-time, 20–40 hrs/wk'],
  ['retail', 'Retail / sales associate', /retail|sales associate|store associate|team member|crew member|associate|merchandis|stocker|stock|clerk/i, [12.5, 17], 'Part-time or full-time, 15–40 hrs/wk'],
  ['server', 'Server / waitstaff', /server|waiter|waitress|waitstaff|busser|food runner|banquet/i, [9, 22], 'Part-time, 15–35 hrs/wk, evenings & weekends (tips included in high end)'],
  ['bartender', 'Bartender', /bartend|barback/i, [10, 25], 'Part-time, evenings & weekends (tips included in high end)'],
  ['barista', 'Barista', /barista|coffee/i, [12, 17], 'Part-time, 15–30 hrs/wk, early mornings'],
  ['host', 'Host', /host|hostess|greeter/i, [11, 15], 'Part-time, 15–30 hrs/wk'],
  ['cook', 'Cook / kitchen', /cook|chef|kitchen|\bprep\b|dishwash|dish ?washer|culinary|baker|pizza/i, [14, 20], 'Full-time or part-time, 25–40 hrs/wk'],
  ['driver', 'Driver / delivery', /driver|delivery|courier|cdl|chauffeur/i, [15, 24], 'Full-time or part-time, 25–40 hrs/wk'],
  ['warehouse', 'Warehouse', /warehouse|forklift|picker|packer|shipping|receiving|loader|material handler/i, [16, 21], 'Full-time, 40 hrs/wk, shifts'],
  ['janitor', 'Cleaning / janitorial', /janitor|custodian|cleaner|housekeep|porter|sanitation/i, [13, 18], 'Full-time or part-time'],
  ['cna', 'Caregiver / CNA', /cna|nursing assistant|caregiver|home health|personal care|patient care|direct support|med tech/i, [15, 21], 'Full-time or part-time, shifts'],
  ['nurse', 'Nurse', /\brn\b|registered nurse|\blpn\b|nurse/i, [28, 48], 'Full-time, 36–40 hrs/wk, 12-hr shifts common'],
  ['medical', 'Medical / dental assistant', /medical assistant|dental assistant|pharmacy tech|phlebotom|veterinary|vet tech|optician|hygienist/i, [17, 24], 'Full-time, 32–40 hrs/wk'],
  ['reception', 'Front desk / reception', /reception|front desk|office assistant|administrative|admin|secretary|scheduler|coordinator/i, [15, 21], 'Full-time, 40 hrs/wk, weekdays'],
  ['mechanic', 'Mechanic / technician', /mechanic|auto tech|lube|\btire|technician|hvac|electrician|plumb|maintenance/i, [18, 30], 'Full-time, 40 hrs/wk'],
  ['labor', 'General labor / trades', /labor|laborer|construction|landscap|installer|helper|apprentice|carpenter|painter|welder/i, [16, 24], 'Full-time, 40 hrs/wk, weekdays'],
  ['security', 'Security', /security|guard|loss prevention/i, [15, 21], 'Full-time or part-time, shifts'],
  ['childcare', 'Childcare / teaching aide', /childcare|child care|daycare|teacher|aide|nanny|tutor|instructor|lifeguard|camp/i, [13, 19], 'Full-time or part-time'],
  ['stylist', 'Stylist / beauty', /stylist|barber|nail|esthetic|cosmetolog|massage/i, [14, 28], 'Full-time or part-time (commission/tips common)'],
  ['manager', 'Manager / supervisor', /manager|supervisor|lead|director|shift lead|key holder|keyholder/i, [18, 30], 'Full-time, 40–50 hrs/wk'],
  ['office', 'Office / professional', /accountant|bookkeep|analyst|engineer|developer|marketing|specialist|representative|customer service|support|sales rep|account/i, [20, 38], 'Full-time, 40 hrs/wk, weekdays'],
];

const FALLBACK = ['general', 'General', null, [14, 20], 'Varies — ask the business'];

export function classifyRole(title) {
  const t = String(title || '');
  // Manager words win over the role they manage ("Kitchen Manager").
  const mgr = ROLES.find((r) => r[0] === 'manager');
  if (mgr[2].test(t) && !/assistant to/i.test(t)) return mgr;
  return ROLES.find((r) => r[2] && r[2].test(t)) || FALLBACK;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mostCommon(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Add `estimatedPay` / `estimatedHours` (and `role`) to every job missing them.
 * jobs: [{ title, businessId, pay, hours, ... }]
 * Returns the same array (mutated) for convenience.
 */
export function applyEstimates(jobs, { wageFloor = 0 } = {}) {
  for (const j of jobs) {
    const role = classifyRole(j.title);
    j.role = role[0];
    j.roleLabel = role[1];
  }
  const withPay = jobs.filter((j) => j.pay && !j.pay.estimated);
  const withHours = jobs.filter((j) => j.hours && !j.hours.estimated && j.hours.types?.length);

  for (const j of jobs) {
    if (!j.pay) {
      const peers = withPay.filter((p) => p.role === j.role && p !== j);
      let lo, hi, basis;
      if (peers.length) {
        lo = median(peers.map((p) => p.pay.hourlyMin));
        hi = median(peers.map((p) => p.pay.hourlyMax));
        basis = `median of ${peers.length} similar ${j.roleLabel.toLowerCase()} job${peers.length > 1 ? 's' : ''} found nearby`;
      } else {
        const role = classifyRole(j.title);
        [lo, hi] = role[3];
        basis = `typical ${role[1].toLowerCase()} pay (rough U.S. range)`;
      }
      if (wageFloor) { lo = Math.max(lo, wageFloor); hi = Math.max(hi, lo); }
      j.estimatedPay = { hourlyMin: r2(lo), hourlyMax: r2(hi), unit: 'hour', estimated: true, basis };
    } else {
      delete j.estimatedPay;
    }

    if (!j.hours || !j.hours.types?.length) {
      const peers = withHours.filter((p) => p.role === j.role && p !== j);
      if (peers.length) {
        const type = mostCommon(peers.flatMap((p) => p.hours.types));
        j.estimatedHours = { text: `${type} (most common for similar jobs nearby)`, estimated: true, basis: `${peers.length} similar job${peers.length > 1 ? 's' : ''}` };
      } else {
        const role = classifyRole(j.title);
        j.estimatedHours = { text: role[4], estimated: true, basis: `typical for ${role[1].toLowerCase()}` };
      }
    } else {
      delete j.estimatedHours;
    }
  }
  return jobs;
}

export function formatPay(p) {
  if (!p) return '';
  const f = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n % 1 ? n.toFixed(2) : n}`);
  if (p.unit === 'year' && p.min) {
    const range = p.min === p.max ? f(p.min) : `${f(p.min)}–${f(p.max)}`;
    return `${range}/yr (~$${p.hourlyMin}${p.hourlyMax !== p.hourlyMin ? `–${p.hourlyMax}` : ''}/hr)`;
  }
  return p.hourlyMin === p.hourlyMax ? `${f(p.hourlyMin)}/hr` : `${f(p.hourlyMin)}–${f(p.hourlyMax)}/hr`;
}

export function formatHours(h) {
  if (!h) return '';
  if (h.text) return h.text;
  const parts = [...(h.types || [])];
  if (h.perWeek) parts.push(h.perWeek.min === h.perWeek.max ? `${h.perWeek.min} hrs/wk` : `${h.perWeek.min}–${h.perWeek.max} hrs/wk`);
  if (h.schedule?.length) parts.push(...h.schedule.slice(0, 2));
  return parts.join(', ');
}
