// server.js — a small, simple backend for Sirat.
const express = require('express');
const cors = require('cors');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/', (req, res) => {
  res.send(`Sirat backend is running. API key is ${API_KEY ? 'set' : 'MISSING'}.`);
});

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Could not parse Claude response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/ask', async (req, res) => {
  console.log('Received a question at', new Date().toISOString());
  try {
    const data = await callClaude(req.body);
    res.json(data);
  } catch (err) {
    console.error('Server error while asking Claude:', err.message);
    res.status(500).json({ error: 'Something went wrong reaching Claude.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sirat backend running on port ${PORT}`));
