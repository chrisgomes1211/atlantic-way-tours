import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTours } from './tours.js';

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

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 800
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'LLM service error', detail: errText });
    }

    const data = await openaiRes.json();
    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: OPENAI_MODEL, agentsDir: AGENTS_DIR });
});

app.listen(PORT, () => {
  console.log(`Atlantic Way Tours API running on port ${PORT}`);
});
