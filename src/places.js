// Finds businesses on the map using OpenStreetMap (free, no API key).

const UA = `JobAppFinder/1.0 (${process.env.CONTACT_EMAIL || 'personal job search tool'})`;
const OVERPASS_URLS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
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

export function buildQuery(lat, lon, radiusMeters, includeNoWebsite) {
  const a = `(around:${Math.round(radiusMeters)},${lat},${lon})`;
  const filters = includeNoWebsite
    ? [`nwr${a}["name"][~"^(${KEYS})$"~"."]`]
    : [
      `nwr${a}["name"]["website"][~"^(${KEYS})$"~"."]`,
      `nwr${a}["name"]["contact:website"][~"^(${KEYS})$"~"."]`,
      `nwr${a}["name"]["url"][~"^(${KEYS})$"~"."]`,
    ];
  return `[out:json][timeout:90];(${filters.join(';')};);out center tags;`;
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

export function parseElements(elements, lat, lon) {
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.amenity && SKIP_AMENITY.test(tags.amenity)) continue;
    const plat = el.lat ?? el.center?.lat;
    const plon = el.lon ?? el.center?.lon;
    if (plat == null) continue;
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
      address: address || null,
      hours: tags.opening_hours || null,
    });
  }
  return out.sort((x, y) => x.distance - y.distance);
}

export async function findBusinesses({ lat, lon, radiusMiles, includeNoWebsite = false }) {
  const query = buildQuery(lat, lon, radiusMiles * 1609.34, includeNoWebsite);
  let lastErr;
  for (const base of OVERPASS_URLS) {
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(100_000),
      });
      if (!res.ok) throw new Error(`Map data server returned ${res.status}`);
      const data = await res.json();
      return parseElements(data.elements || [], lat, lon);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not load businesses from the map: ${lastErr?.message}`);
}
