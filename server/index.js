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
    const { messages, weather: clientWeather } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Live data at query time — each failure is tolerated separately
    let tours = [];
    let weather = {};
    const tools = [];
    try {
      tours = await fetchTours();
      tools.push('search_catalogue');
    } catch (e) {
      console.error('Tours unavailable:', e.message.slice(0, 100));
    }
    try {
      weather = await fetchWeather(tours.length ? tours : [{ latitude: 53.2707, longitude: -9.0568 }]);
      tools.push('weather_forecast');
    } catch (e) {
      if (clientWeather && typeof clientWeather === 'object') {
        const filtered = {};
        for (const t of tours) {
          const w = clientWeather[`${t.latitude},${t.longitude}`];
          if (w && w.forecast) filtered[`${t.latitude},${t.longitude}`] = { forecast: w.forecast.slice(0, 4) };
        }
        if (Object.keys(filtered).length) {
          weather = filtered;
          tools.push('weather_forecast');
          console.log('Used client-provided weather (' + Object.keys(filtered).length + ' locations)');
        }
      }
      if (!tools.includes('weather_forecast')) console.error('Weather unavailable:', e.message.slice(0, 100));
    }

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
      '- "tours": 1-3 recommended tours (max 3) with the exact fields above. Empty array if the user is not asking about specific tours.\n' +
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

    res.json({ reply, tools: outTools, tours: outTours });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

app.post('/api/orchestrate', async (req, res) => {
  try {
    let files;
    try {
      files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith('.md')).sort();
    } catch {
      return res.status(404).json({ error: 'No agents found. Create the /agents markdown files first.' });
    }

    if (files.length === 0) {
      return res.status(404).json({ error: 'No agents found. Create the /agents markdown files first.' });
    }

    const kickoff = req.body?.prompt || 'Run the full analysis for Atlantic Way Tours: weather-driven revenue loss and the weather-adaptive tour recommender opportunity.';
    const log = [];
    let previousOutput = kickoff;

    try {
      const liveData = await buildLiveDataPackage();
      previousOutput = kickoff + '\n\n' + liveData;
      log.push({ step: 0, agent: 'live-data', status: 'done', detail: liveData.split('\n')[2] });
    } catch (e) {
      log.push({ step: 0, agent: 'live-data', status: 'error', detail: e.message.slice(0, 120) });
    }

    for (const file of files) {
      const system = await readFile(path.join(AGENTS_DIR, file), 'utf8');
      log.push({ step: files.indexOf(file) + 1, agent: file, status: 'running' });
      try {
        const reply = await callOpenAI(system, previousOutput);
        previousOutput = reply;
        log.push({
          step: files.indexOf(file) + 1,
          agent: file,
          status: 'done',
          handoffTo: files[files.indexOf(file) + 1] || null,
          output: reply
        });
      } catch (e) {
        log.push({ step: files.indexOf(file) + 1, agent: file, status: 'error', detail: e.message });
        return res.status(502).json({ error: `Agent ${file} failed`, log });
      }
    }

    res.json({ status: 'complete', log });
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
