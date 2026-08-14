const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSBM94SDaxtp9LNOwEiwNDq0rZECZqybNtmNg9dtw8XSP8knAkxGTIzLbhl-8oPVGgLB_9f7-0hz1X3/pub?output=csv';
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, data: null };

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function normalize(rows) {
  return rows.map((r, i) => ({
    id: r.tour_id || `AWT-${String(i + 1).padStart(3, '0')}`,
    name: r.tour_name,
    location: r.location,
    latitude: parseFloat(r.latitude),
    longitude: parseFloat(r.longitude),
    type: r.type,
    price_eur: parseFloat(r.price_eur),
    duration: r.duration,
    weather_sensitive: r.weather_sensitive,
    capacity: parseInt(r.capacity, 10),
    slots_available: parseInt(r.slots_available, 10),
    availability: r.availability,
    special_offer: r.special_offer,
    description: r.description
  }));
}

export async function fetchTours() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status})`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error('Sheet returned no rows');
  cache = { at: Date.now(), data: normalize(rows) };
  return cache.data;
}
