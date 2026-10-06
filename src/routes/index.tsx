import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Mic,
  MicOff,
  X,
  SlidersHorizontal,
  MessageSquare,
  LockKeyhole,
  Volume2,
  LogOut,
  Headphones,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useLiveVoice, type LiveEvent } from "@/hooks/use-live-voice";
import { getConversation } from "@/lib/conversation.functions";
import fluid from "@/assets/mora-fluid.jpg";
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mora — A little space to talk" },
      {
        name: "description",
        content:
          "Your space for a natural conversation with Mora. Talk, listen and pick up where you left off.",
      },
      { property: "og:title", content: "Mora — A little space to talk" },
      { property: "og:description", content: "A calm, personal voice companion." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Mora,
});
type Caption = { role: string; text: string };
function Mora() {
  const [session, setSession] = useState<Session | null>(null);
  const [dialog, setDialog] = useState<"account" | "settings" | "history" | null>(null);
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [saved, setSaved] = useState<Caption[]>([]);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [saveError, setSaveError] = useState("");
  const fetchHistory = useServerFn(getConversation);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setSaved([]);
      setCaptions([]);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  function onEvent(event: LiveEvent) {
    if (event.type === "app.history.error")
      setSaveError(event.error?.message ?? "Conversation could not be saved.");
    if (event.type === "session.usage.updated" && typeof event.usage?.seconds === "number")
      setSeconds(event.usage.seconds);
    if (
      (event.type === "session.input_transcript.delta" ||
        event.type === "session.output_transcript.delta") &&
      typeof event["delta"] === "string"
    ) {
      const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
      const text = event["delta"];
      setCaptions((prev) => {
        const last = prev.at(-1);
        return last?.role === role
          ? [...prev.slice(0, -1), { role, text: last.text + text }]
          : [...prev, { role, text }];
      });
    }
  }
  const voice = useLiveVoice({ token: session?.access_token, onEvent });
  const active = voice.status === "connected";
  const running = voice.status === "connected" || voice.status === "connecting";
  async function auth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const result = signup
        ? await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin },
          })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (signup && !result.data.session) setNotice("Check your email to confirm your account.");
      else setDialog(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  async function history() {
    setDialog("history");
    if (!session) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const rows = await fetchHistory();
      const grouped: Caption[] = [];
      let lastCall = "";
      for (const row of rows ?? []) {
        const last = grouped.at(-1);
        if (last?.role === row.role && lastCall === row.call_id) last.text += row.content;
        else grouped.push({ role: row.role, text: row.content });
        lastCall = row.call_id;
      }
      setSaved(grouped);
    } catch {
      setHistoryError("Your saved conversation could not be loaded.");
    } finally {
      setHistoryLoading(false);
    }
  }
  function start() {
    if (!session) {
      setDialog("account");
      setNotice("");
      return;
    }
    setCaptions([]);
    setSaveError("");
    setSeconds(0);
    voice.start();
  }
  return (
    <main className={`mora-shell ${active ? "is-live" : ""}`}>
      <header className="mora-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          mora
        </div>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="icon"
            title="Conversation"
            aria-label="Conversation"
            onClick={() => void history()}
          >
            <MessageSquare />
          </Button>
          <span className="header-divider" />
          <Button
            variant="ghost"
            className="header-account"
            onClick={() => {
              setNotice("");
              setDialog("account");
            }}
          >
            {session ? "My account" : "Sign in"}
            {!session && <span aria-hidden="true">↗</span>}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Voice settings"
            aria-label="Voice settings"
            onClick={() => setDialog("settings")}
          >
            <SlidersHorizontal />
          </Button>
        </div>
      </header>
      <section className="voice-space">
        <div className="mode-label">
          <span className="mode-dot" />
          Mora voice
        </div>
        <div
          className={`mora-orb ${active ? "is-active" : ""}`}
          role="img"
          aria-label="Mora’s flowing blue voice bubble"
        >
          <img src={fluid} width={1024} height={1024} alt="" />
        </div>
        <h1 className="voice-heading">
          {active
            ? voice.muted
              ? "Take your time."
              : "I’m here. Let’s talk."
            : voice.status === "connecting"
              ? "Connecting to Mora…"
              : voice.status === "stopping"
                ? "Until next time."
                : "A little space to talk."}
        </h1>
        <p className="voice-subtitle" role="status">
          {active
            ? voice.muted
              ? "Microphone muted"
              : "Just you and Mora."
            : running
              ? "Getting your voice ready."
              : "Your thoughts. Your pace. Your Mora."}
        </p>
        <div className="voice-status" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        {captionsOn && captions.at(-1) && (
          <p className="mt-6 max-w-lg text-center text-sm text-muted-foreground">
            {captions.at(-1)?.text}
          </p>
        )}
        {(voice.error || saveError) && (
          <p role="alert" className="error-note">
            {voice.error || saveError}
          </p>
        )}
        {voice.playbackBlocked && (
          <Button variant="outline" onClick={voice.resumePlayback} className="mt-4">
            <Volume2 />
            Play Mora’s voice
          </Button>
        )}
      </section>
      <footer className="voice-bottom">
        <div className="call-controls">
          <div className="control-item">
            <Button
              variant="ghost"
              className="call-button"
              aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
              title={voice.muted ? "Unmute microphone" : "Mute microphone"}
              disabled={!running}
              onClick={() => voice.setMuted(!voice.muted)}
            >
              {voice.muted ? <MicOff /> : <Mic />}
            </Button>
            <span className="control-label">{voice.muted ? "Unmute" : "Microphone"}</span>
          </div>
          <div className="control-item">
            <Button
              variant="ghost"
              className={`call-primary ${running ? "call-end" : ""}`}
              aria-label={running ? "End call" : "Start call"}
              title={running ? "End call" : "Start call"}
              disabled={voice.status === "stopping"}
              onClick={running ? voice.stop : start}
            >
              {running ? <X /> : <Headphones />}
            </Button>
            <span className="control-label">{running ? "End call" : "Start talking"}</span>
          </div>
          <div className="control-item">
            <Button
              variant="ghost"
              className="call-button"
              aria-label="Open conversation"
              title="Open conversation"
              onClick={() => void history()}
            >
              <MessageSquare />
            </Button>
            <span className="control-label">Conversation</span>
          </div>
        </div>
        <div className="footer-note">
          <LockKeyhole size={11} />
          {session
            ? "Your conversation is saved to your account"
            : "A private moment, just for you."}
        </div>
        <span className="page-foot">Made for a more human conversation.</span>
      </footer>
      <audio ref={voice.audioRef} className="hidden" autoPlay />
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="dialog-body">
          <DialogHeader>
            <DialogTitle>
              {dialog === "settings"
                ? "Voice settings"
                : dialog === "history"
                  ? "Your conversation"
                  : session
                    ? "Your account"
                    : "Welcome to Mora"}
            </DialogTitle>
          </DialogHeader>
          {dialog === "settings" && (
            <div className="form-stack">
              <div className="flex items-center justify-between">
                <span>Live captions</span>
                <Switch
                  aria-label="Live captions"
                  checked={captionsOn}
                  onCheckedChange={setCaptionsOn}
                />
              </div>
              <div className="flex justify-between text-sm">
                <span>Voice</span>
                <span className="text-muted-foreground">Marin</span>
              </div>
              {active && (
                <p className="text-xs text-muted-foreground">
                  Voice usage: {Math.max(15, Math.ceil(seconds))} seconds
                </p>
              )}
              <div className="flex items-center justify-between">
                <span>Speaker volume</span>
                <input
                  aria-label="Speaker volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue="1"
                  onChange={(e) => {
                    if (voice.audioRef.current)
                      voice.audioRef.current.volume = Number(e.target.value);
                  }}
                />
              </div>
            </div>
          )}
          {dialog === "history" && (
            <div className="history-panel">
              {!session ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Sign in to keep your conversation with you.
                  </p>
                  <Button onClick={() => setDialog("account")}>Sign in</Button>
                </>
              ) : historyLoading ? (
                <p role="status">Loading conversation…</p>
              ) : historyError ? (
                <p role="alert">{historyError}</p>
              ) : saved.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Your conversation starts with your first call.
                </p>
              ) : (
                saved.map((row, i) => (
                  <div key={i} className="transcript-row">
                    <div className="transcript-role">{row.role === "user" ? "You" : "Mora"}</div>
                    {row.text}
                  </div>
                ))
              )}
            </div>
          )}
          {dialog === "account" &&
            (session ? (
              <div className="form-stack">
                <p className="text-sm text-muted-foreground">{session.user.email}</p>
                <Button
                  variant="outline"
                  onClick={async () => {
                    voice.stop();
                    await supabase.auth.signOut();
                    setDialog(null);
                  }}
                >
                  <LogOut />
                  Sign out
                </Button>
              </div>
            ) : (
              <div className="form-stack">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const result = await supabase.auth.signInWithOAuth({
                      provider: "google",
                      options: {
                        redirectTo: window.location.origin,
                      },
                    });
                    if (result.error) setNotice(result.error.message);
                    else setDialog(null);
                  }}
                >
                  Continue with Google
                </Button>
                <div className="text-center text-xs text-muted-foreground">or with email</div>
                <form className="form-stack" onSubmit={auth}>
                  <label htmlFor="email">Email</label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                  <label htmlFor="password">Password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={signup ? "new-password" : "current-password"}
                    placeholder="At least 8 characters"
                  />
                  <Button disabled={busy} type="submit">
                    {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
                  </Button>
                </form>
                {notice && (
                  <p className="notice" role="status">
                    {notice}
                  </p>
                )}
                <Button
                  variant="link"
                  onClick={() => {
                    setSignup(!signup);
                    setNotice("");
                  }}
                >
                  {signup ? "Already have an account? Sign in" : "New to Mora? Create an account"}
                </Button>
              </div>
            ))}
        </DialogContent>
      </Dialog>
    </main>
  );
}
