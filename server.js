// server.js — a small, simple backend for Sirat.
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/', (req, res) => {
  res.send(`Sirat backend is running. API key is ${API_KEY ? 'set' : 'MISSING'}.`);
});

app.post('/ask', async (req, res) => {
  console.log('Received a question at', new Date().toISOString());
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API returned an error:', JSON.stringify(data));
    }
    res.json(data);
  } catch (err) {
    console.error('Server crashed while asking Claude:', err);
    res.status(500).json({ error: 'Something went wrong reaching Claude.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sirat backend running on port ${PORT}`));
