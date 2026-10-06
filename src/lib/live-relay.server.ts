import { GoogleGenerativeAI } from "@google/generative-ai";
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type LiveConfig = {
  geminiKey: string;
  geminiModel: string;
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

type WorkerSocket = WebSocket & { accept(): void };
declare const WebSocketPair: { new (): { 0: WorkerSocket; 1: WorkerSocket } };

const conversationInstructions = `You are Mora, a warm, calm conversational companion. You speak in natural, brief replies. Be honest about uncertainty. Never claim to be human.

Language policy (CRITICAL — follow exactly):
- Detect the language the user is speaking and ALWAYS respond in that same language.
- If the user speaks Hindi, reply in Hindi. If they speak Telugu, reply in Telugu. If they speak Tamil, reply in Tamil. This applies to every language — Spanish, French, Japanese, Korean, Arabic, Chinese, German, Portuguese, or any other language.
- If the user switches languages mid-conversation or uses a mix of languages (code-switching), adapt immediately and respond in the dominant language of the current utterance or a similar natural mix.
- Never default to English unless the user is speaking English.
- Keep your tone natural and conversational in every language, avoiding robotic or overly formal phrasing.

Personality:
- Be warm, empathetic, and a good listener.
- Give brief, natural responses (1-3 sentences usually).
- Ask follow-up questions to keep the conversation flowing.
- Remember context from earlier in the conversation.
- Use a conversational tone, not a formal or robotic one.`;

export function getLiveConfig(): LiveConfig {
  const key = process.env["GEMINI_API_KEY"] ?? "";
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
  }
  return {
    geminiKey: key,
    geminiModel: "gemini-2.0-flash",
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

function workerSocket(socket: WorkerSocket): LiveSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => socket.addEventListener("message", (event) => handler(event.data)),
    onClose: (handler) => socket.addEventListener("close", handler),
    onError: (handler) => socket.addEventListener("error", handler),
  };
}

export function handleLiveRequest(request: Request): Response {
  const waitUntil = (request as Request & Partial<LiveExecutionContext>).waitUntil;
  if (!waitUntil) return new Response("Live runtime unavailable", { status: 503 });
  const config = getLiveConfig();
  const rejected = validateLiveUpgrade(request);
  if (rejected) return rejected;
  const pair = new WebSocketPair();
  pair[1].accept();
  bindLiveConnection(workerSocket(pair[1]), config, { waitUntil });
  const response: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: pair[0] };
  return new Response(null, response);
}

type ChatMessage = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
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
  // Heartbeat logic is handled by the gateway client

  // Conversation history for Gemini context
  const chatHistory: ChatMessage[] = [];

  // Initialize Gemini
  const genAI = new GoogleGenerativeAI(config.geminiKey);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: conversationInstructions,
  });

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

    // Save user transcript
    saveFragment("user", text);

    // Emit user transcript delta for captions
    emit({
      type: "session.input_transcript.delta",
      delta: text,
    });

    // Add to history
    chatHistory.push({
      role: "user",
      parts: [{ text }],
    });

    try {
      // Start a chat session with history
      const chat = model.startChat({
        history: chatHistory.slice(0, -1), // All history except the latest message
      });

      // Send the latest message
      const result = await chat.sendMessage(text);
      const response = result.response.text();

      if (closing) return;

      if (response.trim()) {
        // Add assistant response to history
        chatHistory.push({
          role: "model",
          parts: [{ text: response }],
        });

        // Save assistant transcript
        saveFragment("assistant", response);

        // Send response to browser for TTS
        emit({
          type: "assistant.response",
          text: response,
        });

        // Also emit transcript delta for captions
        emit({
          type: "session.output_transcript.delta",
          delta: response,
        });
      }
    } catch (error) {
      console.error("Gemini API error:", error);
      if (!closing) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to get response from Mora";

        // Check for rate limiting
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
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: identity, error: authError } = await client.auth.getUser(token);
    if (authError || !identity.user) throw new Error("Please sign in again to start a call.");
    ownerID = identity.user.id;
    accountClient = client;

    // Load conversation history from Supabase
    const { data: history, error: historyError } = await client
      .from("voice_fragments")
      .select("role,content")
      .eq("user_id", ownerID)
      .order("created_at", { ascending: false })
      .limit(30);

    if (historyError) {
      console.error("History load error:", historyError);
    } else if (history && history.length > 0) {
      // Build conversation history for Gemini context
      const grouped: Array<{ role: "user" | "model"; text: string }> = [];
      for (const row of (history ?? []).reverse()) {
        const role = row.role === "assistant" ? "model" : "user";
        const previous = grouped.at(-1);
        if (previous?.role === role) previous.text += row.content;
        else grouped.push({ role, text: row.content });
      }

      // Add recent history to chat context (last 10 exchanges)
      for (const entry of grouped.slice(-10)) {
        chatHistory.push({
          role: entry.role as "user" | "model",
          parts: [{ text: entry.text.slice(-800) }],
        });
      }
    }

    if (closing || browser.readyState !== 1) return;

    // Signal ready to the browser
    emit({ type: "session.ready" });

    // Send a greeting
    const greetingPrompt =
      chatHistory.length > 0
        ? "The user has returned for another conversation. Give a brief, warm welcome back. If their previous messages were in a non-English language, greet them in that language. Keep it to 1-2 sentences."
        : "A new user has started a conversation. Give a brief, warm greeting and ask one friendly opening question. Keep it to 1-2 sentences.";

    try {
      const chat = model.startChat({ history: chatHistory });
      const result = await chat.sendMessage(greetingPrompt);
      const greeting = result.response.text();

      if (closing) return;

      if (greeting.trim()) {
        chatHistory.push(
          { role: "user", parts: [{ text: greetingPrompt }] },
          { role: "model", parts: [{ text: greeting }] },
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
      // Non-fatal — user can still talk
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
        // User interrupted — no action needed on server side for now
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
