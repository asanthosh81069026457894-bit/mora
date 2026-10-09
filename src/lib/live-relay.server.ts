import { GoogleGenerativeAI } from "@google/generative-ai";
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type LiveConfig = {
  groqKey: string;
  groqModel: string;
};

export type LiveSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
};

export type LiveExecutionContext = { waitUntil(task: Promise<unknown>): void };
export type LiveConnector = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<LiveSocket>;

const conversationInstructions = "You are Mora, a warm, intelligent, highly capable conversational AI companion. You gladly fulfill whatever the user asks — whether it's answering questions, giving advice, telling stories, roleplaying, or singing songs! When asked to sing, write out rhythmic, poetic lyrics full of expression so the voice synthesis sings them naturally.\n\nLanguage policy (CRITICAL — follow exactly):\n- Detect the language the user is speaking and ALWAYS respond in that same language.\n- Supports all languages worldwide including Hindi, Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Spanish, French, German, Japanese, Korean, Arabic, Chinese, etc.\n- If the user switches languages mid-conversation or mixes languages, adapt immediately and respond in that language.\n- Never default to English unless the user is speaking English.\n\nPersonality & Versatility:\n- Be enthusiastic, empathetic, and exceptionally helpful.\n- Fulfill every user request cheerfully and creatively.\n- Keep responses engaging, natural, and conversational.";

const FALLBACK_MODELS = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "gemma2-9b-it", "qwen-2.5-32b", "mixtral-8x7b-32768"];

export function getLiveConfig(): LiveConfig {
  const key = process.env["GROQ_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
  if (!key) {
    throw new Error("Missing GROQ_API_KEY environment variable");
  }
  return {
    groqKey: key,
    groqModel: process.env["GROQ_MODEL"] ?? "llama-3.1-8b-instant",
  };
}

export function validateLiveUpgrade(
  request: Request,
  options: { allowMissingOrigin?: boolean } = {},
): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null ? !options.allowMissingOrigin : origin !== new URL(request.url).origin) {
    return new Response("Voice connection origin rejected", { status: 403 });
  }
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket required", { status: 426 });
  }
  return null;
}

export function handleLiveRequest(request: Request): Response {
  const waitUntil = (request as Request & Partial<LiveExecutionContext>).waitUntil;
  if (!waitUntil) return new Response("Live runtime unavailable", { status: 503 });

  // We just need to check if it's a valid upgrade request
  const rejected = validateLiveUpgrade(request);
  if (rejected) return rejected;

  return new Response(null, {
    status: 101,
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
    },
  });
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export function bindLiveConnection(
  browser: LiveSocket,
  configuration: LiveConfig,
  execution: LiveExecutionContext,
): void {
  const config = { ...configuration };
  let closing = false;
  let finished = false;
  let ownerID: string | undefined;
  const callID = crypto.randomUUID();
  let accountClient: SupabaseClient<Database> | undefined;
  let saveQueue = Promise.resolve();

  const chatHistory: ChatMessage[] = [];

  async function callOpenRouter(messages: Array<{ role: string; content: string }>) {
    const key = process.env["OPENROUTER_API_KEY"] || process.env["VITE_OPENROUTER_API_KEY"];
    if (!key) throw new Error("OPENROUTER_API_KEY not configured.");
    const models = [
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen-2.5-72b-instruct:free",
      "google/gemma-2-9b-it:free",
      "deepseek/deepseek-r1:free",
    ];
    let lastErr: Error | null = null;
    for (const model of models) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key.trim()}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://mora.app",
            "X-Title": "Mora Voice Assistant",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: conversationInstructions },
              ...messages,
            ],
            temperature: 0.7,
            max_tokens: 1024,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const text = (data.choices?.[0]?.message?.content || "").trim();
          if (text) return text;
        } else {
          const errText = await res.text();
          console.error(`OpenRouter (${model}) failed (${res.status}):`, errText);
          try {
            const parsed = JSON.parse(errText);
            if (parsed.error?.message) lastErr = new Error(`OpenRouter: ${parsed.error.message}`);
          } catch (_) {
            lastErr = new Error(`OpenRouter status ${res.status}`);
          }
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr || new Error("OpenRouter free models unavailable.");
  }

  async function callGeminiAPI(messages: Array<{ role: string; content: string }>) {
    const key = process.env["GEMINI_API_KEY"] || process.env["VITE_GEMINI_API_KEY"];
    if (!key) throw new Error("GEMINI_API_KEY not configured.");
    const geminiModels = ["gemini-2.0-flash", "gemini-1.5-flash"];
    for (const gModel of geminiModels) {
      try {
        const contents = messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${key.trim()}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents,
              systemInstruction: { parts: [{ text: conversationInstructions }] },
            }),
          },
        );
        if (res.ok) {
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
          if (text) return text;
        }
      } catch (_) {}
    }
    throw new Error("Gemini API call failed.");
  }

  async function callGroqAPI(messages: Array<{ role: string; content: string }>) {
    // Preference 1: OpenRouter API
    if (process.env["OPENROUTER_API_KEY"] || process.env["VITE_OPENROUTER_API_KEY"]) {
      try {
        return await callOpenRouter(messages);
      } catch (orErr) {
        console.error("OpenRouter failed:", orErr);
      }
    }

    // Preference 2: Gemini API
    if (process.env["GEMINI_API_KEY"] || process.env["VITE_GEMINI_API_KEY"]) {
      try {
        return await callGeminiAPI(messages);
      } catch (gErr) {
        console.error("Gemini failed:", gErr);
      }
    }

    // Preference 3: Groq API fallback
    const key = process.env["GROQ_API_KEY"] || process.env["VITE_GROQ_API_KEY"];
    if (key) {
      const activeGroqModels = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
      for (const modelCandidate of activeGroqModels) {
        try {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${key.trim()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: modelCandidate,
              messages: [
                { role: "system", content: conversationInstructions },
                ...messages,
              ],
              temperature: 0.7,
              max_tokens: 1024,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const text = (data.choices?.[0]?.message?.content || "").trim();
            if (text) return text;
          }
        } catch (_) {}
      }
    }

    throw new Error("No AI provider available. Please set OPENROUTER_API_KEY or GEMINI_API_KEY in your environment variables.");
  }

  function emit(event: object) {
    if (browser.readyState !== 1) return;
    try {
      browser.send(JSON.stringify(event));
    } catch {
      stop();
    }
  }

  function finish() {
    if (finished) return;
    finished = closing = true;
    browser.close?.(1000, "Call ended");
  }

  function stop() {
    if (closing) return;
    closing = true;
    emit({ type: "session.closed", finalized: true });
    setTimeout(finish, 1000);
  }

  function saveFragment(role: "user" | "assistant", content: string) {
    const client = accountClient;
    if (!client || !ownerID) return;
    const fragment = {
      user_id: ownerID,
      call_id: callID,
      role,
      content,
      start_ms: 0,
      end_ms: 0,
    };
    saveQueue = saveQueue
      .then(async () => {
        const { error } = await client.from("voice_fragments").insert(fragment);
        if (error) {
          emit({
            type: "app.history.error",
            error: { message: "Your conversation could not be saved. Please try again later." },
          });
        }
      })
      .catch(() =>
        emit({
          type: "app.history.error",
          error: { message: "Your conversation could not be saved." },
        }),
      );
    execution.waitUntil(saveQueue);
  }

  async function handleUserSpeech(text: string) {
    if (closing || !text.trim()) return;

    saveFragment("user", text);

    emit({
      type: "session.input_transcript.delta",
      delta: text,
    });

    chatHistory.push({
      role: "user",
      content: text,
    });

    try {
      const response = await callGroqAPI(chatHistory);

      if (closing) return;

      if (response.trim()) {
        chatHistory.push({
          role: "assistant",
          content: response,
        });

        saveFragment("assistant", response);

        emit({
          type: "assistant.response",
          text: response,
        });

        emit({
          type: "session.output_transcript.delta",
          delta: response,
        });
      }
    } catch (error) {
      console.error("Groq API error:", error);
      if (!closing) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to get response from Mora";

        if (errorMessage.includes("429") || errorMessage.toLowerCase().includes("rate")) {
          emit({
            type: "app.error",
            error: { message: "Mora is thinking too fast! Please wait a moment and try again." },
          });
        } else {
          emit({
            type: "assistant.response",
            text: "I'm sorry, I had trouble understanding that. Could you try again?",
          });
        }
      }
    }
  }

  async function startSession(token: unknown) {
    if (typeof token !== "string" || !token) {
      throw new Error("Sign in to talk with Mora and save your conversation.");
    }

    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) throw new Error("Account connection is unavailable.");

    const client = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: "Bearer " + token } },
    });

    const { data: identity, error: authError } = await client.auth.getUser(token);
    if (authError || !identity.user) throw new Error("Please sign in again to start a call.");
    ownerID = identity.user.id;
    accountClient = client;

    const { data: history, error: historyError } = await client
      .from("voice_fragments")
      .select("role,content")
      .eq("user_id", ownerID)
      .order("created_at", { ascending: false })
      .limit(30);

    if (historyError) {
      console.error("History load error:", historyError);
    } else if (history && history.length > 0) {
      for (const row of (history ?? []).reverse()) {
        const role = row.role === "assistant" ? "assistant" : "user";
        chatHistory.push({ role, content: row.content });
      }
    }

    if (closing || browser.readyState !== 1) return;

    emit({ type: "session.ready" });

    const greetingPrompt =
      chatHistory.length > 0
        ? "The user has returned for another conversation. Give a brief, warm welcome back. If their previous messages were in a non-English language, greet them in that language. Keep it to 1-2 sentences."
        : "A new user has started a conversation. Give a brief, warm greeting and ask one friendly opening question. Keep it to 1-2 sentences.";

    try {
      const greeting = await callGroqAPI([
        ...chatHistory,
        { role: "user", content: greetingPrompt },
      ]);

      if (closing) return;

      if (greeting.trim()) {
        chatHistory.push(
          { role: "user", content: greetingPrompt },
          { role: "assistant", content: greeting },
        );

        emit({
          type: "assistant.response",
          text: greeting,
        });
        emit({
          type: "session.output_transcript.delta",
          delta: greeting,
        });
      }
    } catch (error) {
      console.error("Greeting error:", error);
    }
  }

  browser.onMessage((data) => {
    try {
      if (typeof data !== "string" || data.length > 64 * 1024)
        throw new Error("Invalid client message");
      const event = JSON.parse(data);

      if (event.type === "session.close") return stop();
      if (closing) return;

      if (event.type === "app.start") {
        execution.waitUntil(
          startSession(event.token).catch((error) => {
            if (!closing)
              emit({
                type: "app.error",
                error: { message: error instanceof Error ? error.message : "Voice startup failed" },
              });
            stop();
          }),
        );
        return;
      }

      if (event.type === "user.speech" && typeof event.text === "string") {
        execution.waitUntil(
          handleUserSpeech(event.text).catch((error) => {
            console.error("Speech handling error:", error);
          }),
        );
        return;
      }

      if (event.type === "user.interrupt") {
        return;
      }

      if (event.type === "gateway.heartbeat") {
        emit({ type: "gateway.heartbeat.ack" });
        return;
      }
    } catch {
      emit({
        type: "app.error",
        error: { message: "Voice connection could not be started or continued" },
      });
      stop();
    }
  });

  browser.onClose(stop);
  browser.onError(stop);
}
