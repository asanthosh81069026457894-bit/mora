try {
  require('dotenv').config();
} catch (e) {
  // Environment variables provided natively by host (Render/Vercel)
}
const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_MODELS = [
  GROQ_MODEL,
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'qwen-2.5-32b',
  'llama-3.3-70b-versatile',
  'mixtral-8x7b-32768',
  'llama3-8b-8192',
  'llama3-70b-8192',
];
const GROQ_MODEL_QUEUE = [...new Set(GROQ_MODELS)];

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://vvfdrvogvnhkntjkxyhh.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_vYjrnmVEeOcOWtOYmz8GKg_1zdYGzVx';

const SYSTEM_INSTRUCTION = `You are Mora, a warm, intelligent, highly capable conversational AI companion. You gladly fulfill whatever the user asks — whether it's answering questions, giving advice, telling stories, roleplaying, or singing songs! When asked to sing, write out rhythmic, poetic lyrics full of expression so the voice synthesis sings them naturally.

Language Policy (CRITICAL — follow exactly):
- Detect the language the user is speaking and ALWAYS respond in that same language.
- Supports all languages worldwide including Hindi, Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Spanish, French, German, Japanese, Korean, Arabic, Chinese, etc.
- If the user switches languages mid-conversation or mixes languages, adapt immediately.
- Never default to English unless the user is speaking English.

Personality & Versatility:
- Be enthusiastic, empathetic, and exceptionally helpful.
- Fulfill every user request cheerfully and creatively.
- Keep responses engaging, natural, and conversational.`;

const HAS_AI_KEY = Boolean(GROQ_API_KEY || OPENROUTER_API_KEY || GEMINI_API_KEY);

if (!HAS_AI_KEY || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.warn('WARNING: Missing environment variables on Render! Required: An AI key (GROQ_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY), SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY');
}

async function callOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured.');
  const models = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-2-9b-it:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'deepseek/deepseek-r1:free',
  ];
  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY.trim()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://mora.app',
          'X-Title': 'Mora Voice Assistant',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            ...messages
          ],
          temperature: 0.7,
          max_tokens: 1024,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (text.trim()) return text.trim();
      }
    } catch (_) {}
  }
  throw new Error('OpenRouter free models unavailable.');
}

async function callGemini(messages) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured.');
  const geminiModels = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const gModel of geminiModels) {
    try {
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${GEMINI_API_KEY.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
        })
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text.trim()) return text.trim();
      }
    } catch (_) {}
  }
  throw new Error('Gemini API call failed');
}

async function callGroq(messages) {
  let groqErr = null;
  if (GROQ_API_KEY) {
    for (const modelCandidate of GROQ_MODEL_QUEUE) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelCandidate,
            messages: [
              { role: 'system', content: SYSTEM_INSTRUCTION },
              ...messages
            ],
            temperature: 0.7,
            max_tokens: 1024,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.choices?.[0]?.message?.content || '';
          if (text.trim()) return text.trim();
        }

        const errText = await response.text();
        console.error(`Groq (${modelCandidate}) failed ${response.status}:`, errText);

        if (response.status === 401) {
          groqErr = new Error('Invalid GROQ_API_KEY. Please verify your Groq key.');
          break;
        }
        if (response.status === 429) {
          groqErr = new Error('Groq rate limit reached (429).');
          break;
        }
        try {
          const parsed = JSON.parse(errText);
          if (parsed.error?.message) groqErr = new Error(`Groq: ${parsed.error.message}`);
        } catch (_) {
          groqErr = new Error(`Groq status ${response.status}`);
        }
      } catch (e) {
        groqErr = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  if (OPENROUTER_API_KEY) {
    try {
      return await callOpenRouter(messages);
    } catch (orErr) {
      console.error('OpenRouter fallback failed:', orErr);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      return await callGemini(messages);
    } catch (gErr) {
      console.error('Gemini fallback failed:', gErr);
    }
  }

  throw groqErr || new Error('No valid AI key found. Please add GROQ_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY to your environment variables.');
}

// Create HTTP server for Render health checks and WebSockets
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const missing = [];
    if (!GROQ_API_KEY) missing.push('GROQ_API_KEY');
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');

    const ready = missing.length === 0;
    res.writeHead(ready ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: ready ? 'ok' : 'error',
      service: 'Mora Voice Relay',
      provider: 'Groq API',
      model: GROQ_MODEL,
      message: ready
        ? 'Voice Relay Server is running with Groq API'
        : `Missing environment variables on Render: ${missing.join(', ')}`
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
  const missing = [];
  if (!GROQ_API_KEY) missing.push('GROQ_API_KEY');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');

  if (missing.length > 0) {
    console.error('Connection rejected: Environment variables missing on server:', missing);
    ws.send(JSON.stringify({
      type: 'app.error',
      error: { message: `Server configuration error: Missing ${missing.join(', ')} in Render environment variables.` }
    }));
    ws.close(1011, 'Server unconfigured');
    return;
  }

  let ownerID = null;
  let accountClient = null;
  let chatHistory = [];
  let closing = false;

  ws.on('message', async (data) => {
    if (closing) return;
    try {
      const event = JSON.parse(data);

      if (event.type === 'app.start') {
        const token = event.token;
        if (!token) {
          ws.send(JSON.stringify({ type: 'app.error', error: { message: 'Please sign in to start a voice call.' } }));
          return;
        }

        accountClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });

        const { data: { user }, error: authError } = await accountClient.auth.getUser(token);
        if (authError || !user) {
          console.error('Auth verification failed:', authError);
          ws.send(JSON.stringify({ type: 'app.error', error: { message: 'Please sign in to talk with Mora.' } }));
          return;
        }
        ownerID = user.id;

        // Load history
        const { data: history, error: historyErr } = await accountClient
          .from('voice_fragments')
          .select('role,content')
          .eq('user_id', ownerID)
          .order('created_at', { ascending: false })
          .limit(20);

        if (historyErr) {
          console.error('History fetch error:', historyErr);
        }

        if (history) {
          chatHistory = history.reverse().map(row => ({
            role: row.role === 'assistant' ? 'assistant' : 'user',
            content: row.content
          }));
        }

        ws.send(JSON.stringify({ type: 'session.ready' }));

        // Greeting
        const promptText = chatHistory.length > 0
          ? "Welcome back the user warmly in their language. Keep it to 1-2 sentences."
          : "Greet the user warmly and ask one friendly opening question. Keep it to 1-2 sentences.";

        try {
          const greeting = await callGroq([
            ...chatHistory,
            { role: 'user', content: promptText }
          ]);

          if (greeting) {
            chatHistory.push({ role: 'user', content: promptText });
            chatHistory.push({ role: 'assistant', content: greeting });

            ws.send(JSON.stringify({ type: 'assistant.response', text: greeting }));
            ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: greeting }));
          }
        } catch (genErr) {
          console.error('Greeting Generation Error:', genErr);
          const fallbackGreeting = "Hello! I'm Mora. How can I help you today?";
          ws.send(JSON.stringify({ type: 'assistant.response', text: fallbackGreeting }));
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: fallbackGreeting }));
        }
      }

      if (event.type === 'user.speech' && event.text) {
        const text = event.text;

        // Save user fragment
        if (accountClient && ownerID) {
          await accountClient.from('voice_fragments').insert({
            user_id: ownerID,
            role: 'user',
            content: text,
          });
        }

        ws.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: text }));

        chatHistory.push({ role: 'user', content: text });

        try {
          const response = await callGroq(chatHistory);

          if (response) {
            chatHistory.push({ role: 'assistant', content: response });

            if (accountClient && ownerID) {
              await accountClient.from('voice_fragments').insert({
                user_id: ownerID,
                role: 'assistant',
                content: response,
              });
            }

            ws.send(JSON.stringify({ type: 'assistant.response', text: response }));
            ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: response }));
          }
        } catch (e) {
          console.error('Groq Error:', e);
          const errMessage = e instanceof Error ? e.message : 'Mora is having trouble responding right now.';
          ws.send(JSON.stringify({ type: 'app.error', error: { message: errMessage } }));
        }
      }

      if (event.type === 'gateway.heartbeat') {
        ws.send(JSON.stringify({ type: 'gateway.heartbeat.ack' }));
      }

      if (event.type === 'session.close') {
        closing = true;
        ws.close();
      }
    } catch (e) {
      console.error('Message Error:', e);
      const errMsg = e instanceof Error ? e.message : 'Server error occurred';
      ws.send(JSON.stringify({ type: 'app.error', error: { message: errMsg } }));
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(PORT, HOST, () => {
  console.log(`Voice Relay Server (Groq API) listening on http://${HOST}:${PORT}`);
});

