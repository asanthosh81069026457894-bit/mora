import { useCallback, useEffect, useRef, useState } from "react";

export type LiveEvent = {
  type: string;
  reason?: string;
  error?: { message?: string };
  usage?: { seconds?: number };
  finalized?: boolean;
  transport?: { type?: string; sdp?: string };
  [key: string]: unknown;
};

type LiveState = {
  status: "idle" | "connecting" | "connected" | "stopping" | "closed";
  error: string | null;
  hasConnected: boolean;
  finalized: boolean | null;
  muted: boolean;
  playbackBlocked: boolean;
};

const initialState: LiveState = {
  status: "idle",
  error: null,
  hasConnected: false,
  finalized: null,
  muted: false,
  playbackBlocked: false,
};

export function useLiveVoice(
  options: {
    url?: string;
    token?: string | undefined;
    onEvent?: (event: LiveEvent) => void | Promise<void>;
  } = {},
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controller = useRef<ReturnType<typeof createLiveVoice> | null>(null);
  const mounted = useRef(false);
  const latest = useRef(options);
  const [call, setCall] = useState(initialState);

  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const voice = controller.current;
      controller.current = null;
      voice?.stop();
    };
  }, []);

  const start = useCallback(() => {
    if (!mounted.current || controller.current) return;
    const audio = audioRef.current;
    if (!audio) {
      setCall((previous) => ({ ...previous, error: "Voice playback is not mounted." }));
      return;
    }

    // VERCEL FIX: Use an environment variable for the Voice Server URL
    // In Vercel, set VITE_VOICE_URL to your Railway URL (e.g. wss://your-relay.up.railway.app)
    const voiceUrl = import.meta.env.VITE_VOICE_URL || "/api/live";

    let endpoint: URL;
    try {
      endpoint = new URL(voiceUrl, window.location.href);
      if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
      if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    } catch {
      setCall((previous) => ({ ...previous, error: "Invalid voice connection URL." }));
      return;
    }

    const voice = createLiveVoice({
      url: endpoint.href,
      token: latest.current.token,
      audio,
      onEvent(event) {
        if (!mounted.current || controller.current !== voice) return;
        if (event.type === "app.connected") {
          setCall((previous) => ({ ...previous, status: "connected", hasConnected: true }));
        } else if (event.type === "app.stopping") {
          setCall((previous) => ({ ...previous, status: "stopping", playbackBlocked: false }));
        } else if (event.type === "app.closed") {
          controller.current = null;
          setCall((previous) => ({
            ...previous,
            status: "closed",
            muted: false,
            playbackBlocked: false,
            finalized: event.finalized === true,
          }));
        } else if (event.type === "app.playback.blocked" || event.type === "app.playback.resumed") {
          setCall((previous) => ({
            ...previous,
            playbackBlocked: event.type === "app.playback.blocked",
          }));
        } else if (["app.error", "gateway.error", "error"].includes(event.type)) {
          setCall((previous) => ({
            ...previous,
            error: event.error?.message ?? "Voice request failed.",
          }));
        }
        try {
          void Promise.resolve(latest.current.onEvent?.(event)).catch((error) => {
            console.error("Live UI event handler failed", error);
          });
        } catch (error) {
          console.error("Live UI event handler failed", error);
        }
      },
    });
    controller.current = voice;
    setCall({ ...initialState, status: "connecting" });
    void voice.start();
  }, []);

  const stop = useCallback(() => {
    controller.current?.stop();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    if (controller.current?.setMuted(muted)) setCall((previous) => ({ ...previous, muted }));
  }, []);

  const resumePlayback = useCallback(() => {
    void controller.current?.resumePlayback();
  }, []);

  return { ...call, audioRef, start, stop, setMuted, resumePlayback };
}

type LiveOptions = {
  token?: string | undefined;
  url: string;
  audio: HTMLAudioElement;
  onEvent: (event: LiveEvent) => void;
};

const SpeechRecognitionClass = (typeof window !== "undefined" &&
  ((window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition)) as
  (new () => SpeechRecognition) | undefined;

function createLiveVoice(options: LiveOptions) {
  let state: "idle" | "starting" | "active" | "stopping" | "closed" = "idle";
  let socket: WebSocket | undefined;
  let recognition: SpeechRecognition | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let muted = false;
  let finalized = false;
  let startTime = 0;
  let speaking = false;
  let currentUtterance: SpeechSynthesisUtterance | null = null;
  let lastAck = 0;

  function starting() {
    return state === "starting";
  }

  function send(event: object) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function stopRecognition() {
    try {
      recognition?.stop();
    } catch {
      // already stopped
    }
    recognition = undefined;
  }

  function stopSpeaking() {
    speaking = false;
    currentUtterance = null;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function release() {
    if (state === "closed") return;
    state = "closed";
    clearInterval(heartbeat);
    clearInterval(usageTimer);
    clearTimeout(deadline);
    stopRecognition();
    stopSpeaking();
    window.removeEventListener("pagehide", stop);
    socket?.close();
    options.onEvent({ type: "app.closed", finalized });
  }

  function stop() {
    if (state === "stopping" || state === "closed") return;
    state = "stopping";
    try {
      send({ type: "session.close" });
    } catch {
      return release();
    }
    stopRecognition();
    stopSpeaking();
    clearInterval(heartbeat);
    clearInterval(usageTimer);
    clearTimeout(deadline);
    deadline = setTimeout(release, 5_000);
    options.onEvent({ type: "app.stopping" });
    if (!socket || socket.readyState !== WebSocket.OPEN) release();
  }

  function setMuted(value: boolean) {
    if (state !== "starting" && state !== "active") return false;
    muted = value;
    if (muted) {
      stopRecognition();
    } else if (state === "active") {
      startRecognition();
    }
    return true;
  }

  async function resumePlayback() {
    if (state !== "starting" && state !== "active") return;
    options.onEvent({ type: "app.playback.resumed" });
  }

  function fail(message: string) {
    if (state === "stopping" || state === "closed") return;
    options.onEvent({ type: "app.error", error: { message } });
    stop();
  }

  function speakText(text: string) {
    if (state === "stopping" || state === "closed") return;
    if (!window.speechSynthesis) return;

    stopSpeaking();
    speaking = true;

    const utterance = new SpeechSynthesisUtterance(text);
    currentUtterance = utterance;

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const preferred = voices.find(
        (v) =>
          v.lang.startsWith(navigator.language.slice(0, 2)) &&
          v.name.toLowerCase().includes("female"),
      );
      const fallback = voices.find((v) => v.lang.startsWith(navigator.language.slice(0, 2)));
      if (preferred) utterance.voice = preferred;
      else if (fallback) utterance.voice = fallback;
    }

    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      speaking = false;
      currentUtterance = null;
      if (state === "active" && !muted) {
        startRecognition();
      }
    };

    utterance.onerror = () => {
      speaking = false;
      currentUtterance = null;
      if (state === "active" && !muted) {
        startRecognition();
      }
    };

    stopRecognition();

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      speaking = false;
      if (state === "active" && !muted) {
        startRecognition();
      }
    }
  }

  function startRecognition() {
    if (!SpeechRecognitionClass || muted || state !== "active") return;
    if (recognition) return;

    try {
      const rec = new SpeechRecognitionClass();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = "";

      rec.onresult = (event: SpeechRecognitionEvent) => {
        if (state !== "active") return;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result?.[0]) continue;
          const transcript = result[0].transcript;

          if (result.isFinal && transcript.trim()) {
            options.onEvent({
              type: "session.input_transcript.delta",
              delta: transcript,
            });
            send({
              type: "user.speech",
              text: transcript,
              final: true,
            });

            if (speaking) {
              stopSpeaking();
              send({ type: "user.interrupt" });
            }
          }
        }
      };

      rec.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === "no-speech" || event.error === "aborted") {
          recognition = undefined;
          if (state === "active" && !muted && !speaking) {
            setTimeout(() => startRecognition(), 300);
          }
          return;
        }
        recognition = undefined;
        if (state === "active" && !muted && !speaking) {
          setTimeout(() => startRecognition(), 1000);
        }
      };

      rec.onend = () => {
        recognition = undefined;
        if (state === "active" && !muted && !speaking) {
          setTimeout(() => startRecognition(), 200);
        }
      };

      rec.start();
      recognition = rec;
    } catch (error) {
      recognition = undefined;
      if (state === "active" && !muted && !speaking) {
        setTimeout(() => startRecognition(), 1000);
      }
    }
  }

  function pulse() {
    if (state !== "active") return;
    if (socket?.readyState !== WebSocket.OPEN) return fail("Voice connection lost");
    if (Date.now() - lastAck >= 15000) return fail("Voice server not responding");
    try {
      send({ type: "gateway.heartbeat" });
    } catch {
      fail("Voice connection failed");
    }
  }

  async function start() {
    if (state !== "idle") return;
    state = "starting";
    window.addEventListener("pagehide", stop);

    if (!SpeechRecognitionClass) {
      fail("Your browser does not support speech recognition. Please use Chrome or Edge.");
      return;
    }

    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        fail("Microphone permission is required for voice calls.");
        return;
      }

      if (!starting()) return;

      if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
      }

      socket = new WebSocket(options.url);
      deadline = setTimeout(() => fail("Voice session did not start"), 15_000);

      socket.onopen = () => {
        if (!starting()) return release();
        send({ type: "app.start", token: options.token });
      };

      socket.onmessage = ({ data }) => {
        try {
          const event: LiveEvent = JSON.parse(data);

          if (event.type === "session.ready") {
            if (!starting()) return;
            state = "active";
            startTime = Date.now();
            clearTimeout(deadline);
            lastAck = Date.now();
            heartbeat = setInterval(pulse, 5000);
            usageTimer = setInterval(() => {
              if (state !== "active") return;
              const elapsed = Math.floor((Date.now() - startTime) / 1000);
              options.onEvent({
                type: "session.usage.updated",
                usage: { seconds: elapsed },
              });
            }, 1000);
            if (!muted) startRecognition();
            options.onEvent({ type: "app.connected" });
          } else if (event.type === "assistant.response") {
            const text = typeof event["text"] === "string" ? event["text"] : "";
            if (text.trim()) {
              options.onEvent({
                type: "session.output_transcript.delta",
                delta: text,
              });
              speakText(text);
            }
          } else if (event.type === "gateway.heartbeat.ack") {
            lastAck = Date.now();
          } else if (event.type === "session.closed") {
            finalized = true;
            options.onEvent(event);
            return release();
          } else if (
            event.type === "app.error" ||
            event.type === "gateway.error" ||
            event.type === "error"
          ) {
            options.onEvent(event);
            return stop();
          }

          options.onEvent(event);
        } catch {
          fail("Invalid voice event");
        }
      };

      socket.onerror = () => fail("Voice connection failed");
      socket.onclose = () => {
        if (state !== "stopping" && state !== "closed") {
          options.onEvent({
            type: "app.error",
            error: { message: "Voice connection closed" },
          });
        }
        release();
      };
    } catch (error) {
      fail(error instanceof Error ? error.message : "Voice startup failed");
    }
  }

  return { start, stop, setMuted, resumePlayback };
}
