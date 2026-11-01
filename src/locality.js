// Decides whether a job is in the home area or somewhere else.
// Chain and big-organization websites list jobs from everywhere, so a job
// found on a local store's website isn't necessarily at that store.

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_RE = `(?:${Object.keys(STATES).join('|')}|${Object.values(STATES).join('|')})`;
// "Birmingham, AL", "Austin, Texas"
const CITY_STATE = new RegExp(`\\b([A-Z][A-Za-z.']+(?:[ -][A-Z][A-Za-z.']+){0,3}),\\s*(${STATE_RE})\\b`, 'g');
const FOREIGN = /\b(UK|U\.K\.|United Kingdom|England|Scotland|Ireland|Canada|Mexico|India|Philippines|Australia|Germany|France|Spain|Netherlands|Singapore|Japan|China|Brazil|EMEA|APAC|LATAM)\b/;
// "Program Aide – Birmingham Metro", "Assistant – Birmingham Office"
const PLACE_SUFFIX = /[–—-]\s*([A-Z][A-Za-z.' ]+?)\s+(Office|Area|Metro|Region|Campus|Location|Branch)\b/;
const REMOTE = /\b(remote|work from home|telecommut)/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ctx: { towns: [names in the area], homeState: 'AL' }
 * Returns a matcher: where(job, { chain }) -> { where: 'local' | 'away', note }
 */
export function localityChecker({ towns, homeState = 'AL' }) {
  const names = [...new Set(towns.map((t) => t.trim()).filter((t) => t.length > 2))];
  const stateName = STATES[homeState] || homeState;
  const stateRe = `(?:${esc(homeState)}|${esc(stateName)})`;
  // In a job's location field, a plain town name is enough.
  const inField = names.length ? new RegExp(`\\b(${names.map(esc).join('|')})\\b`, 'i') : null;
  // In free text, common words ("Section", "Lebanon") need the state after them.
  const inText = names.length ? new RegExp(`\\b(${names.map(esc).join('|')}),?\\s+${stateRe}\\b`, 'i') : null;
  const county = /\bDeKalb County\b/i;

  return function where(job, { chain = false } = {}) {
    const loc = job.location;
    if (loc) {
      if (inField?.test(loc)) return { where: 'local' };
      if (REMOTE.test(loc)) return { where: 'away', note: 'Remote' };
      return { where: 'away', note: loc };
    }
    const title = job.title || '';
    const text = `${title} ${job.snippet || ''}`;
    if (inText?.test(text) || county.test(text)) return { where: 'local' };
    const elsewhere = [...text.matchAll(CITY_STATE)].map((m) => m[0]);
    if (elsewhere.length) return { where: 'away', note: elsewhere[0] };
    const foreign = title.match(FOREIGN);
    if (foreign) return { where: 'away', note: foreign[1] };
    const suffix = title.match(PLACE_SUFFIX);
    if (suffix && !inField?.test(suffix[1])) return { where: 'away', note: `${suffix[1]} ${suffix[2]}` };
    if (REMOTE.test(title)) return { where: 'away', note: 'Remote' };
    // A chain's careers site that doesn't say where the job is: company-wide, not this store.
    if (chain) return { where: 'away', note: 'Company-wide listing; location not stated' };
    return { where: 'local' };
  };
}
