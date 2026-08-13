const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 10;

const cache = new Map();

export function uniqueLocations(tours) {
  const seen = new Map();
  for (const t of tours) {
    const key = `${t.latitude},${t.longitude}`;
    if (!seen.has(key)) seen.set(key, { lat: t.latitude, lon: t.longitude });
  }
  return [...seen.values()];
}

async function fetchBatch(coords) {
  const url = `${WEATHER_URL}?latitude=${coords.map(c => c.lat).join(',')}` +
    `&longitude=${coords.map(c => c.lon).join(',')}` +
    `&daily=precipitation_probability_max,temperature_2m_max&timezone=auto&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Weather response is not an array');

  const map = {};
  coords.forEach((c, i) => {
    const d = data[i];
    if (!d || !d.daily) return;
    map[`${c.lat},${c.lon}`] = {
      latitude: c.lat,
      longitude: c.lon,
      timezone: d.timezone,
      forecast: d.daily.time.map((day, j) => ({
        date: day,
        precipitation_probability_max: d.daily.precipitation_probability_max[j],
        temperature_2m_max: d.daily.temperature_2m_max[j]
      }))
    };
  });
  return map;
}

export async function fetchWeather(tours) {
  const coords = uniqueLocations(tours);
  const cacheKey = coords.map(c => `${c.lat},${c.lon}`).join('|');

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const result = {};
  for (let i = 0; i < coords.length; i += BATCH_SIZE) {
    const batch = coords.slice(i, i + BATCH_SIZE);
    Object.assign(result, await fetchBatch(batch));
  }

  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}
