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

const conversationInstructions = "You are Mora, a warm, intelligent, highly capable conversational AI companion. You gladly fulfill whatever the user asks — whether it's answering questions, giving advice, telling stories, roleplaying, or singing songs! When asked to sing, write out rhythmic, poetic lyrics full of expression so the voice synthesis sings them naturally.\n\nLanguage policy (CRITICAL — follow exactly):\n- Detect the language the user is speaking and ALWAYS respond in that same language.\n- Supports all languages worldwide including Hindi, Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Spanish, French, German, Japanese, Korean, Arabic, Chinese, etc.\n- If the user switches languages mid-conversation or mixes languages, adapt immediately and respond in that language.\n- Never default to English unless the user is speaking English.\n\nPersonality & Versatility:\n- Be enthusiastic, empathetic, and exceptionally helpful.\n- Fulfill every user request cheerfully and creatively.\n- Keep responses engaging, natural, and conversational.";

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

  const chatHistory: ChatMessage[] = [];

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

    saveFragment("user", text);

    emit({
      type: "session.input_transcript.delta",
      delta: text,
    });

    chatHistory.push({
      role: "user",
      parts: [{ text }],
    });

    try {
      const chat = model.startChat({
        history: chatHistory.slice(0, -1),
      });

      const result = await chat.sendMessage(text);
      const response = result.response.text();

      if (closing) return;

      if (response.trim()) {
        chatHistory.push({
          role: "model",
          parts: [{ text: response }],
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
      console.error("Gemini API error:", error);
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
      const grouped: Array<{ role: "user" | "model"; text: string }> = [];
      for (const row of (history ?? []).reverse()) {
        const role = row.role === "assistant" ? "model" : "user";
        const previous = grouped.at(-1);
        if (previous?.role === role) previous.text += row.content;
        else grouped.push({ role, text: row.content });
      }

      for (const entry of grouped.slice(-10)) {
        chatHistory.push({
          role: entry.role as "user" | "model",
          parts: [{ text: entry.text.slice(-800) }],
        });
      }
    }

    if (closing || browser.readyState !== 1) return;

    emit({ type: "session.ready" });

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
