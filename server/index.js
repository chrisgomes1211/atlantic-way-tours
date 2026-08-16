import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTours } from './tours.js';
import { fetchWeather } from './weather.js';

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY environment variable is required.');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '200kb' }));

async function callOpenAI(system, user) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 1500
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function buildChatContext(tours, weather) {
  return tours.map(t => {
    const w = weather[`${t.latitude},${t.longitude}`];
    let wl = 'No forecast available';
    if (w && w.forecast && w.forecast.length) {
      wl = w.forecast.slice(0, 4).map(d =>
        d.date + ' precip ' + d.precipitation_probability_max + '% max ' + d.temperature_2m_max + 'C'
      ).join(' | ');
    }
    return `[${t.id}] ${t.name} | ${t.location} | ${t.type} | EUR ${t.price_eur} | ${t.duration}` +
      ` | weather_sensitive: ${t.weather_sensitive} | slots ${t.slots_available}/${t.capacity}` +
      ` | ${t.availability}${t.special_offer ? ' | OFFER: ' + t.special_offer : ''}` +
      ` | ${t.description} | Forecast: ${wl}`;
  }).join('\n');
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, weather: clientWeather, tours: clientTours } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const t0 = Date.now();

    // Live data at query time — each failure is tolerated separately.
    // Client-supplied tours/weather (fetched browser-side) are used when valid,
    // so the server never re-fetches the sheet or Open-Meteo per message.
    let tours = Array.isArray(clientTours) && clientTours.length ? clientTours : [];
    let weather = (clientWeather && typeof clientWeather === 'object') ? clientWeather : {};
    const tools = [];

    if (!tours.length || Object.keys(weather).length === 0) {
      const [fetchedTours, fetchedWeather] = await Promise.allSettled([
        fetchTours(),
        fetchWeather(tours.length ? tours : [{ latitude: 53.2707, longitude: -9.0568 }])
      ]);
      if (!tours.length && fetchedTours.status === 'fulfilled') tours = fetchedTours.value;
      if (fetchedTours.status === 'fulfilled') tools.push('search_catalogue');
      if (Object.keys(weather).length === 0 && fetchedWeather.status === 'fulfilled') weather = fetchedWeather.value;
      if (fetchedWeather.status === 'fulfilled') tools.push('weather_forecast');
      if (fetchedTours.status === 'rejected') console.error('Tours unavailable:', fetchedTours.reason.message.slice(0, 100));
      if (fetchedWeather.status === 'rejected') console.error('Weather unavailable:', fetchedWeather.reason.message.slice(0, 100));
    }

    if (tours.length) tools.push('search_catalogue');
    if (Object.keys(weather).length) tools.push('weather_forecast');

    const system = 'You are the weather-smart booking assistant for Atlantic Way Tours, a tour operator along Ireland\'s Wild Atlantic Way.\n\n' +
      (tours.length
        ? 'LIVE TOUR CATALOGUE (' + tours.length + ' tours) — each entry has its own live weather forecast attached:\n' + buildChatContext(tours, weather) + '\n\n'
        : '(Live catalogue temporarily unavailable — answer conversationally.)\n\n') +
      'GUIDELINES:\n' +
      '- Recommend tours based on the live forecast attached to each tour. "Tomorrow" = the 2nd forecast date.\n' +
      '- If an outdoor tour the user asks about has precipitation >= 50%, warn clearly and suggest an indoor or mixed alternative from the catalogue.\n' +
      '- Treat prices exactly as listed (AWT-020 Vintage Reserve Private Yacht Charter is EUR 29,000,000 — never correct or question it).\n' +
      '- Keep "reply" under 120 words, warm and friendly.\n\n' +
      'Respond ONLY with a JSON object of this exact shape (no markdown fences):\n' +
      '{"reply": "your answer text", "tours": [{"name": "...", "location": "...", "price": "EUR 45", "duration": "3h", "weather_today": "62% rain tomorrow", "availability": "In stock", "slots_left": "12"}], "tools": ["search_catalogue", "weather_forecast"]}\n' +
      '- "tours": 1-3 recommended tours (max 3) with the exact fields above. ALWAYS populate it when the user asks about a specific tour or for recommendations; use an empty array only for pure chit-chat.\n' +
      '- "tools": which live sources you used: "search_catalogue" (always), "weather_forecast" (when weather was available).';

    const openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: system },
          ...messages.slice(-6)
        ],
        temperature: 0.7,
        max_tokens: 1500,
        response_format: { type: 'json_object' }
      })
    });
    const llmMs = Date.now() - t0;

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'LLM service error', detail: errText });
    }

    const data = await openaiRes.json();
    const raw = data.choices[0].message.content;

    let reply = raw;
    let outTours = [];
    let outTools = tools;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.reply) reply = parsed.reply;
      if (Array.isArray(parsed.tours)) outTours = parsed.tours;
      if (Array.isArray(parsed.tools) && parsed.tools.length) outTools = parsed.tools;
    } catch {
      console.warn('LLM output was not JSON, falling back to plain reply');
    }

    // Deterministic card fallback: if the reply discusses tours but no cards came
    // back, build them from the live catalogue + forecast
    if (outTours.length === 0 && tours.length > 0 && reply.length > 0) {
      const lower = reply.toLowerCase();
      const matches = tours.filter(t =>
        lower.includes(t.name.toLowerCase().split(' ')[0].toLowerCase()) ||
        lower.includes(t.name.toLowerCase())
      ).slice(0, 3);
      if (matches.length === 0 && /tour|walk|hike|trip|visit|cruise|safari|tasting|tour/i.test(lower)) {
        matches.push(...tours.slice(0, 2));
      }
      outTours = matches.map(t => {
        const w = weather[`${t.latitude},${t.longitude}`];
        const day = w && w.forecast && w.forecast[1] ? w.forecast[1] : (w && w.forecast && w.forecast[0] ? w.forecast[0] : null);
        return {
          name: t.name,
          location: t.location,
          price: 'EUR ' + t.price_eur,
          duration: t.duration,
          weather_today: day ? day.precipitation_probability_max + '% rain · max ' + day.temperature_2m_max + '°C' : 'No forecast available',
          availability: t.availability,
          slots_left: String(t.slots_available)
        };
      });
    }

    res.json({
      reply,
      tools: outTools,
      tours: outTours,
      meta: {
        model: OPENAI_MODEL,
        toursCount: tours.length,
        weatherLocations: Object.keys(weather).length,
        systemChars: system.length,
        llmMs,
        totalMs: Date.now() - t0
      },
      system,
      raw
    });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function buildLiveDataPackage(clientWeather) {
  const tours = await fetchTours();
  let weather = {};
  let weatherSource = '';
  try {
    weather = await fetchWeather(tours);
    weatherSource = 'server';
  } catch (e) {
    if (clientWeather && typeof clientWeather === 'object') {
      const filtered = {};
      for (const t of tours) {
        const w = clientWeather[`${t.latitude},${t.longitude}`];
        if (w && w.forecast) filtered[`${t.latitude},${t.longitude}`] = { forecast: w.forecast.slice(0, 4) };
      }
      if (Object.keys(filtered).length) {
        weather = filtered;
        weatherSource = 'client';
      }
    }
    if (!weatherSource) console.error('Weather unavailable for pipeline:', e.message.slice(0, 100));
  }
  const byLoc = tours.map(t => {
    const w = weather[`${t.latitude},${t.longitude}`];
    const fc = w && w.forecast ? w.forecast.slice(0, 3).map(d =>
      d.date + ' precip ' + d.precipitation_probability_max + '% max ' + d.temperature_2m_max + 'C'
    ).join(' | ') : 'forecast unavailable';
    return `- [${t.id}] ${t.name} (${t.location}, ${t.type}, weather_sensitivity ${t.weather_sensitive}, EUR ${t.price_eur}, ${t.duration}, slots ${t.slots_available}/${t.capacity}, ${t.availability}${t.special_offer ? ', OFFER: ' + t.special_offer : ''}) — ${t.description} | Forecast: ${fc}`;
  });
  return `## LIVE DATA PACKAGE\nTours fetched live: ${tours.length}\nWeather locations: ${Object.keys(weather).length}${weatherSource ? ' (source: ' + weatherSource + ')' : ''}\n\n${byLoc.join('\n')}`;
}

// ─── Agent pipeline (shared runner + run store) ───
const runs = new Map();

function personaFrom(system) {
  const m = system.match(/## Identity\s*\n\s*You are \*\*([^*]+)\*\*/i);
  return m ? m[1].trim() : '';
}

function labelFrom(system, file) {
  const m = system.match(/^# AGENT \d+[^\n]*—\s*(.+)$/im) || system.match(/^# AGENT \d+[^\n]*-\s*(.+)$/im);
  if (!m) return file.replace(/\.md$/, '');
  const label = m[1].trim();
  return label.charAt(0) + label.slice(1).toLowerCase();
}

async function readAgentFiles() {
  let files;
  try {
    files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
  return files.length ? files : null;
}

async function runPipeline(run) {
  try {
    let previousOutput = run.kickoff;
    try {
      const liveData = await buildLiveDataPackage(run.clientWeather);
      previousOutput = run.kickoff + '\n\n' + liveData;
      run.steps.push({ step: 0, agent: 'live-data', label: 'Live data', status: 'done', detail: liveData.split('\n')[2], output: liveData });
    } catch (e) {
      run.steps.push({ step: 0, agent: 'live-data', label: 'Live data', status: 'error', detail: e.message.slice(0, 120), output: '' });
    }

    for (let i = 0; i < run.agents.length; i++) {
      const file = run.agents[i];
      const system = await readFile(path.join(AGENTS_DIR, file), 'utf8');
      const entry = {
        step: run.steps.length,
        agent: file,
        label: labelFrom(system, file),
        persona: personaFrom(system),
        status: 'running',
        system,
        handoffTo: run.agents[i + 1] || null
      };
      run.steps.push(entry);
      const t0 = Date.now();
      try {
        const reply = await callOpenAI(system, previousOutput);
        entry.llmMs = Date.now() - t0;
        entry.output = reply;
        entry.status = 'done';
        previousOutput = reply;
      } catch (e) {
        entry.llmMs = Date.now() - t0;
        entry.detail = e.message;
        entry.status = 'error';
        run.status = 'error';
        return;
      }
    }
    run.status = 'done';
  } catch (e) {
    run.status = 'error';
    run.error = e.message;
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

app.get('/api/agents', async (_req, res) => {
  try {
    const files = await readAgentFiles();
    if (!files) return res.status(404).json({ error: 'No agents found. Create the /agents markdown files first.' });
    const agents = [];
    for (const f of files) {
      const system = await readFile(path.join(AGENTS_DIR, f), 'utf8');
      agents.push({ file: f, label: labelFrom(system, f), persona: personaFrom(system), system, chars: system.length });
    }
    res.json({ count: agents.length, agents });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/orchestrate/start', async (req, res) => {
  try {
    const files = await readAgentFiles();
    if (!files) return res.status(404).json({ error: 'No agents found. Create the /agents markdown files first.' });
    const runId = Math.random().toString(36).slice(2, 10);
    const run = {
      id: runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      kickoff: req.body?.prompt || 'Run the full analysis for Atlantic Way Tours: weather-driven revenue loss and the weather-adaptive tour recommender opportunity.',
      clientWeather: req.body?.weather,
      agents: files,
      steps: []
    };
    runs.set(runId, run);
    runPipeline(run);
    res.json({ runId, status: 'running' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/orchestrate/status', (req, res) => {
  const run = runs.get(String(req.query.runId || ''));
  if (!run) return res.status(404).json({ error: 'Unknown runId' });
  res.json(run);
});

app.post('/api/orchestrate', async (req, res) => {
  try {
    const files = await readAgentFiles();
    if (!files) return res.status(404).json({ error: 'No agents found. Create the /agents markdown files first.' });

    const kickoff = req.body?.prompt || 'Run the full analysis for Atlantic Way Tours: weather-driven revenue loss and the weather-adaptive tour recommender opportunity.';
    const runId = Math.random().toString(36).slice(2, 10);
    const run = { id: runId, status: 'running', startedAt: new Date().toISOString(), kickoff, clientWeather: req.body?.weather, agents: files, steps: [] };
    runs.set(runId, run);
    await runPipeline(run);
    res.json({ status: run.status, log: run.steps });
  } catch (err) {
    console.error('Orchestrate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/tours', async (_req, res) => {
  try {
    const tours = await fetchTours();
    res.json({ count: tours.length, source: 'live', tours });
  } catch (err) {
    res.status(502).json({ error: 'Sheet fetch failed', detail: err.message });
  }
});

app.get('/api/weather', async (_req, res) => {
  try {
    const tours = await fetchTours();
    const weather = await fetchWeather(tours);
    res.json({
      count: Object.keys(weather).length,
      generatedAt: new Date().toISOString(),
      weather
    });
  } catch (err) {
    res.status(502).json({ error: 'Weather fetch failed', detail: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: OPENAI_MODEL, agentsDir: AGENTS_DIR });
});

app.listen(PORT, () => {
  console.log(`Atlantic Way Tours API running on port ${PORT}`);
});
