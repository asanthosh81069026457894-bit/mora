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

if (!GEMINI_API_KEY) {
  console.warn('WARNING: Missing GEMINI_API_KEY environment variable on server!');
}

async function callGemini(messages) {
  if (!GEMINI_API_KEY || !GEMINI_API_KEY.trim()) {
    throw new Error('GEMINI_API_KEY is not configured on server. Please add your GEMINI_API_KEY starting with AIzaSy in Render dashboard.');
  }

  const geminiModels = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
  let lastErr = null;

  for (const modelName of geminiModels) {
    try {
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY.trim()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
          })
        }
      );

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text.trim()) return text.trim();
      } else {
        const errText = await res.text();
        console.error(`Gemini API Error for ${modelName} (${res.status}):`, errText);
        try {
          const parsed = JSON.parse(errText);
          if (parsed.error?.message) {
            lastErr = new Error(`Gemini: ${parsed.error.message}`);
          }
        } catch (_) {
          lastErr = new Error(`Gemini API returned status ${res.status}`);
        }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr || new Error('Gemini API call failed.');
}

// Create HTTP server for Render health checks and WebSockets
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const missing = [];
    if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');

    const ready = missing.length === 0;
    res.writeHead(ready ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: ready ? 'ok' : 'error',
      service: 'Mora Voice Relay',
      provider: 'Google Gemini API',
      message: ready
        ? 'Voice Relay Server is running with Google Gemini API'
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
  if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
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
          const greeting = await callGemini([
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
          const response = await callGemini(chatHistory);

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
          console.error('Gemini Error:', e);
          const fallbackMessage = e instanceof Error && e.message.includes('GEMINI_API_KEY')
            ? "I can hear you! Please add your GEMINI_API_KEY to your Render environment variables so I can generate AI responses."
            : e instanceof Error ? e.message : "I had a momentary glitch reaching Gemini API. Could you please say that again?";

          ws.send(JSON.stringify({ type: 'assistant.response', text: fallbackMessage }));
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: fallbackMessage }));
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
  console.log(`Voice Relay Server (Google Gemini API) listening on http://${HOST}:${PORT}`);
});

