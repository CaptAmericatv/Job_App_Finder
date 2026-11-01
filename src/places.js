// Finds businesses on the map using OpenStreetMap (free, no API key).

const UA = `JobAppFinder/1.0 (${process.env.CONTACT_EMAIL || 'personal job search tool'})`;
const OVERPASS_URLS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map((s) => s.trim()).filter(Boolean);

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  const data = await res.json();
  return data.map((d) => ({ name: d.display_name, lat: +d.lat, lon: +d.lon }));
}

// Business-type tags worth checking for jobs.
const KEYS = 'shop|amenity|office|craft|tourism|leisure|healthcare|club';
const SKIP_AMENITY = /^(parking|bench|toilets|waste_basket|recycling|drinking_water|post_box|bicycle_parking|vending_machine|atm|charging_station|shelter|telephone|fountain|grave_yard|place_of_worship|parking_entrance|bus_station|taxi)$/;

// A bounding box with one plain filter per business type is far cheaper for
// the map server than "around" plus a regex on tag keys; the circle is
// trimmed afterwards in parseElements.
export function bbox(lat, lon, radiusMeters) {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const r = (n) => n.toFixed(5);
  return `${r(lat - dLat)},${r(lon - dLon)},${r(lat + dLat)},${r(lon + dLon)}`;
}

export function buildQuery(lat, lon, radiusMeters, includeNoWebsite) {
  const box = `(${bbox(lat, lon, radiusMeters)})`;
  const sites = includeNoWebsite ? [''] : ['["website"]', '["contact:website"]', '["url"]'];
  const filters = KEYS.split('|').flatMap((k) => sites.map((w) => `nwr["name"]["${k}"]${w}${box}`));
  return `[out:json][timeout:180];(${filters.join(';')};);out center tags;`;
}

export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function category(tags) {
  for (const k of KEYS.split('|')) if (tags[k]) return `${k}: ${tags[k]}`.replace(/_/g, ' ');
  return 'business';
}

export function normalizeWebsite(url) {
  if (!url) return null;
  let u = String(url).split(';')[0].trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
  } catch {
    return null;
  }
}

// Facebook page link from a tag (full URL, "facebook.com/x" or just a page name).
export function facebookUrl(v) {
  if (!v) return null;
  const t = String(v).split(';')[0].trim();
  if (/^https?:\/\//i.test(t)) return /facebook\.com|fb\.com/i.test(t) ? t : null;
  if (/^(www\.)?(facebook|fb)\.com\//i.test(t)) return `https://${t}`;
  return /^[\w.-]+$/.test(t) ? `https://www.facebook.com/${t}` : null;
}

export function parseElements(elements, lat, lon, maxMiles = Infinity) {
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.amenity && SKIP_AMENITY.test(tags.amenity)) continue;
    const plat = el.lat ?? el.center?.lat;
    const plon = el.lon ?? el.center?.lon;
    if (plat == null) continue;
    if (distanceMiles(lat, lon, plat, plon) > maxMiles) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ');
    out.push({
      id,
      name: tags.name,
      brand: tags.brand || null,
      category: category(tags),
      lat: plat,
      lon: plon,
      distance: Math.round(distanceMiles(lat, lon, plat, plon) * 100) / 100,
      website: normalizeWebsite(tags.website || tags['contact:website'] || tags.url || tags['brand:website']),
      phone: tags.phone || tags['contact:phone'] || null,
      facebook: facebookUrl(tags['contact:facebook'] || tags.facebook || (/facebook\.com/i.test(tags.website || '') ? tags.website : null)),
      address: address || null,
      city: tags['addr:city'] || null,
      hours: tags.opening_hours || null,
    });
  }
  return out.sort((x, y) => x.distance - y.distance);
}

// The public map servers are often busy (504). Try each one, and go round
// a few times with a pause before giving up.
async function overpass(query, timeoutMs) {
  let lastErr;
  for (let round = 0; round < 3; round++) {
    if (round) await new Promise((r) => setTimeout(r, 30_000 * round));
    for (const base of OVERPASS_URLS) {
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Map data server returned ${res.status}`);
        const data = await res.json();
        if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

export async function findBusinesses({ lat, lon, radiusMiles, includeNoWebsite = false }) {
  const query = buildQuery(lat, lon, radiusMiles * 1609.34, includeNoWebsite);
  try {
    const data = await overpass(query, 200_000);
    return parseElements(data.elements || [], lat, lon, radiusMiles);
  } catch (e) {
    throw new Error(`Could not load businesses from the map: ${e.message}`);
  }
}

// Names of towns and villages in the area, for telling local jobs from ones elsewhere.
export async function findTowns({ lat, lon, radiusMiles }) {
  const query = `[out:json][timeout:60];node["place"~"^(city|town|village|hamlet|suburb)$"](${bbox(lat, lon, radiusMiles * 1609.34)});out tags;`;
  const data = await overpass(query, 90_000);
  return (data.elements || []).map((e) => e.tags?.name).filter(Boolean);
}
