import 'dotenv/config';
import dotenv from 'dotenv';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTours } from '../server/tours.js';
import { fetchWeather } from '../server/weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SERVER_ENV = path.join(ROOT, 'server', '.env');

dotenv.config({ path: SERVER_ENV });

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const KICKOFF = process.argv[2] ||
  'Run the full analysis for Atlantic Way Tours: weather-driven revenue loss and the weather-adaptive tour recommender opportunity.';

if (!KEY) {
  console.error('FATAL: OPENAI_API_KEY missing. Create server/.env (see server/.env.example) or export it.');
  process.exit(1);
}

async function callOpenAI(system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 2500
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function buildLiveDataPackage() {
  const tours = await fetchTours();
  const weather = await fetchWeather(tours);
  const byLoc = tours.map(t => {
    const w = weather[`${t.latitude},${t.longitude}`];
    const fc = w && w.forecast ? w.forecast.slice(0, 3).map(d =>
      d.date + ' precip ' + d.precipitation_probability_max + '% max ' + d.temperature_2m_max + 'C'
    ).join(' | ') : 'no forecast';
    return `- [${t.id}] ${t.name} (${t.location}, ${t.type}, weather_sensitivity ${t.weather_sensitive}, EUR ${t.price_eur}, ${t.duration}, slots ${t.slots_available}/${t.capacity}, ${t.availability}${t.special_offer ? ', OFFER: ' + t.special_offer : ''}) — ${t.description} | Forecast: ${fc}`;
  });
  return `## LIVE DATA PACKAGE\nTours fetched live: ${tours.length}\nWeather locations: ${Object.keys(weather).length}\n\n${byLoc.join('\n')}`;
}

const files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith('.md')).sort();
await mkdir(OUTPUT_DIR, { recursive: true });

const log = [];
let previousOutput = KICKOFF;

console.log('═'.repeat(70));
console.log('  ATLANTIC WAY TOURS — FIVE-AGENT PIPELINE');
console.log(`  Model: ${MODEL} | Agents: ${files.join(', ')}`);
console.log('═'.repeat(70));

try {
  const liveData = await buildLiveDataPackage();
  previousOutput = `${KICKOFF}\n\n${liveData}`;
  console.log('📊  LIVE DATA PACKAGE loaded —', liveData.split('\n')[2]);
} catch (e) {
  console.log('⚠️  Live data unavailable, proceeding with prompt only:', e.message.slice(0, 100));
}

for (const file of files) {
  const system = await readFile(path.join(AGENTS_DIR, file), 'utf8');
  const step = files.indexOf(file) + 1;
  const next = files[step] || 'FINAL';
  console.log('\n' + '─'.repeat(70));
  console.log(`▸ HANDOFF ${step}/${files.length} — ${file} → ${next}`);
  console.log('─'.repeat(70));

  const start = Date.now();
  log.push({ step, agent: file, status: 'running', at: new Date().toISOString() });

  try {
    const output = await callOpenAI(system, previousOutput);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    await writeFile(path.join(OUTPUT_DIR, file.replace('.md', '.txt')), output);
    console.log(`✓ ${file} completed in ${secs}s (${output.length} chars)`);
    console.log('  head:', output.split('\n').slice(0, 2).join(' | ').slice(0, 140));
    log.push({ step, agent: file, status: 'done', seconds: secs, chars: output.length, at: new Date().toISOString() });
    previousOutput = output;
  } catch (e) {
    console.error(`✗ ${file} FAILED:`, e.message);
    log.push({ step, agent: file, status: 'error', error: e.message, at: new Date().toISOString() });
    break;
  }
}

await writeFile(path.join(OUTPUT_DIR, 'handoff-log.json'), JSON.stringify(log, null, 2));
console.log('\n' + '═'.repeat(70));
console.log('  PIPELINE COMPLETE — handoff log: pipeline/output/handoff-log.json');
console.log('═'.repeat(70));
