require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error('Missing required environment variables: GEMINI_API_KEY, SUPABASE_URL, or SUPABASE_PUBLISHABLE_KEY');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: `You are Mora, a warm, intelligent, highly capable conversational AI companion. You gladly fulfill whatever the user asks — whether it's answering questions, giving advice, telling stories, roleplaying, or singing songs! When asked to sing, write out rhythmic, poetic lyrics full of expression so the voice synthesis sings them naturally.

Language Policy (CRITICAL — follow exactly):
- Detect the language the user is speaking and ALWAYS respond in that same language.
- Supports all languages worldwide including Hindi, Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Spanish, French, German, Japanese, Korean, Arabic, Chinese, etc.
- If the user switches languages mid-conversation or mixes languages, adapt immediately.
- Never default to English unless the user is speaking English.

Personality & Versatility:
- Be enthusiastic, empathetic, and exceptionally helpful.
- Fulfill every user request cheerfully and creatively.
- Keep responses engaging, natural, and conversational.`,
});

// Create HTTP server for Render health checks and WebSockets
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Mora Voice Relay' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
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
        if (!token) throw new Error('Missing token');

        accountClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });

        const { data: { user }, error: authError } = await accountClient.auth.getUser(token);
        if (authError || !user) throw new Error('Auth failed');
        ownerID = user.id;

        // Load history
        const { data: history } = await accountClient
          .from('voice_fragments')
          .select('role,content')
          .eq('user_id', ownerID)
          .order('created_at', { ascending: false })
          .limit(20);

        if (history) {
          chatHistory = history.reverse().map(row => ({
            role: row.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: row.content }]
          }));
        }

        ws.send(JSON.stringify({ type: 'session.ready' }));

        // Greeting
        const prompt = chatHistory.length > 0
          ? "Welcome back the user warmly in their language. 1-2 sentences."
          : "Greet the user warmly and ask one friendly opening question. 1-2 sentences.";

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessage(prompt);
        const greeting = result.response.text();

        chatHistory.push({ role: 'user', parts: [{ text: prompt }] });
        chatHistory.push({ role: 'model', parts: [{ text: greeting }] });

        ws.send(JSON.stringify({ type: 'assistant.response', text: greeting }));
        ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: greeting }));
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

        chatHistory.push({ role: 'user', parts: [{ text }] });

        try {
          const chat = model.startChat({ history: chatHistory.slice(0, -1) });
          const result = await chat.sendMessage(text);
          const response = result.response.text();

          chatHistory.push({ role: 'model', parts: [{ text: response }] });

          if (accountClient && ownerID) {
            await accountClient.from('voice_fragments').insert({
              user_id: ownerID,
              role: 'assistant',
              content: response,
            });
          }

          ws.send(JSON.stringify({ type: 'assistant.response', text: response }));
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: response }));
        } catch (e) {
          console.error('Gemini Error:', e);
          ws.send(JSON.stringify({ type: 'app.error', error: { message: 'Mora is having trouble responding.' } }));
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
      ws.send(JSON.stringify({ type: 'app.error', error: { message: 'Server error' } }));
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(PORT, HOST, () => {
  console.log(`Voice Relay Server listening on http://${HOST}:${PORT}`);
});
