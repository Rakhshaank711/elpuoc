"use client";

import {
  ArrowRight, Check, Clipboard, Copy, Eye, EyeOff, Heart, Info,
  MessageCircle, MoreHorizontal, RefreshCw, Send, Share2, SkipForward, Sparkles,
  Users, Wifi, WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLUE_WORD_LIMIT, WORDS_PER_ROUND } from "@/lib/game/constants";
import { countClueWords, formatClock } from "@/lib/game/rules";
import type { GameState, Session } from "@/lib/game/types";
import { getBrowserClient } from "@/lib/supabase/browser";
import { CosmicOrb } from "./cosmic-orb";
import { Avatar, Brand, Button, Field, Screen } from "./ui";

type EntryMode = "landing" | "create" | "join";
type GuessFeedback = { id: number; kind: "wrong" | "correct"; guess?: string };

class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || "Something went wrong", body.code);
  return body as T;
}

function sessionKey(code: string) { return `15words:${code.toUpperCase()}`; }

export function GameApp() {
  const [entry, setEntry] = useState<EntryMode>("landing");
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<GuessFeedback | null>(null);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getBrowserClient>>["channel"]> | null>(null);

  const showFeedback = useCallback((event: Omit<GuessFeedback, "id">) => {
    const next = { ...event, id: Date.now() };
    setFeedback(next);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(event.kind === "correct" ? [35, 30, 70] : [45, 35, 45]);
    }
    window.setTimeout(() => setFeedback((current) => current?.id === next.id ? null : current), 2200);
  }, []);

  const fetchState = useCallback(async (activeSession: Session, quiet = false) => {
    try {
      const result = await requestJson<{ state: GameState }>(`/api/game?code=${activeSession.code}&playerId=${activeSession.playerId}`, {
        headers: { "x-player-token": activeSession.token }, cache: "no-store",
      });
      setState((current) => current && current.roomId === result.state.roomId && current.version > result.state.version ? current : result.state);
      if (!quiet) setError(null);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "Could not load the room");
    }
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("room")?.toUpperCase();
    if (!code) { queueMicrotask(() => setBooting(false)); return; }
    const stored = localStorage.getItem(sessionKey(code));
    if (stored) {
      try {
        const restored = JSON.parse(stored) as Session;
        queueMicrotask(() => {
          setSession(restored);
          void fetchState(restored).finally(() => setBooting(false));
        });
        return;
      } catch { localStorage.removeItem(sessionKey(code)); }
    }
    queueMicrotask(() => {
      setEntry("join");
      setBooting(false);
    });
  }, [fetchState]);

  useEffect(() => {
    if (!session || !state?.roomId) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(`room:${state.roomId}`, {
      config: { presence: { key: session.playerId }, broadcast: { self: false } },
    });
    channelRef.current = channel;
    channel
      .on("broadcast", { event: "state_changed" }, () => void fetchState(session, true))
      .on("broadcast", { event: "guess_feedback" }, ({ payload }) => {
        if (payload?.kind === "wrong" || payload?.kind === "correct") {
          showFeedback({ kind: payload.kind, ...(typeof payload.guess === "string" ? { guess: payload.guess.slice(0, 60) } : {}) });
        }
      })
      .on("presence", { event: "sync" }, () => {
        const presence = channel.presenceState<{ playerId: string }>();
        const ids = Object.values(presence).flat().map((item) => item.playerId).filter(Boolean);
        setConnectedIds(new Set(ids));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ playerId: session.playerId, name: session.name, role: session.role, joinedAt: new Date().toISOString() });
        }
      });
    return () => { channelRef.current = null; void supabase.removeChannel(channel); };
  }, [fetchState, session, showFeedback, state?.roomId]);

  const roomId = state?.roomId;
  useEffect(() => {
    if (!session || !roomId) return;
    const timer = window.setInterval(() => void fetchState(session, true), 5000);
    return () => window.clearInterval(timer);
  }, [fetchState, session, roomId]);

  const enterSession = async (newSession: Session) => {
    localStorage.setItem(sessionKey(newSession.code), JSON.stringify(newSession));
    window.history.replaceState(null, "", `/?room=${newSession.code}`);
    setSession(newSession);
    await fetchState(newSession);
  };

  const submitEntry = async (payload: { action: "create"; name: string; avatar: number } | { action: "join"; name: string; code: string; avatar: number }) => {
    setLoading(true); setError(null);
    try {
      const result = await requestJson<{ session: Session }>("/api/game", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      await enterSession(result.session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not enter the room"); }
    finally { setLoading(false); }
  };

  const mutate = async (payload: Record<string, unknown>) => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const result = await requestJson<{ state: GameState }>("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json", "x-player-id": session.playerId, "x-player-token": session.token },
        body: JSON.stringify({ ...payload, code: session.code }),
      });
      setState((current) => current && current.roomId === result.state.roomId && current.version > result.state.version ? current : result.state);
      if (payload.action === "guess") {
        const event = { kind: "correct" as const };
        showFeedback(event);
        void channelRef.current?.send({ type: "broadcast", event: "guess_feedback", payload: event });
      }
      void channelRef.current?.send({ type: "broadcast", event: "state_changed", payload: { version: result.state.version } });
      return result.state;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "WRONG_GUESS") {
        const event = { kind: "wrong" as const, guess: typeof payload.guess === "string" ? payload.guess : undefined };
        showFeedback(event);
        void channelRef.current?.send({ type: "broadcast", event: "guess_feedback", payload: event });
      }
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
    finally { setLoading(false); }
  };

  if (booting) return <Screen><div className="grid min-h-dvh place-items-center"><Brand /></div></Screen>;
  if (!session || !state) {
    if (entry === "landing") return <Landing onCreate={() => setEntry("create")} onJoin={() => setEntry("join")} />;
    return <EntryForm mode={entry} loading={loading} error={error} onBack={() => { setEntry("landing"); setError(null); }} onSubmit={submitEntry} />;
  }

  const enriched = { ...state, players: state.players.map((p) => ({ ...p, connected: connectedIds.has(p.id) || p.id === session.playerId })) };
  if (state.status === "lobby") return <Lobby state={enriched} loading={loading} error={error} mutate={mutate} />;
  if (state.status === "playing") return <Play state={enriched} loading={loading} error={error} mutate={mutate} feedback={feedback} />;
  if (state.status === "round_result") return <RoundResult state={enriched} loading={loading} error={error} mutate={mutate} />;
  return <FinalResult state={enriched} loading={loading} error={error} mutate={mutate} />;
}

function Landing({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return <Screen plum className="flex min-h-dvh flex-col px-6 pt-10">
    <div className="flex justify-center"><Brand /></div>
    <div className="flex flex-1 flex-col justify-center py-7">
      <CosmicOrb />
      <div className="mt-8">
        <h1 className="headline text-[31px] font-black">Can your partner<br/>read your mind?</h1>
        <p className="mt-4 max-w-[310px] text-[13px] leading-5 text-[var(--muted)]">Help them guess eight words using only fifteen clue words. Then switch roles and see who knows whom best.</p>
      </div>
      <div className="mt-7 space-y-3">
        <Button onClick={onCreate}><span className="inline-flex items-center gap-2"><Sparkles size={15}/> Create a Game</span></Button>
        <Button kind="secondary" onClick={onJoin}><span className="inline-flex items-center gap-2"><Users size={15}/> Join a Game</span></Button>
      </div>
    </div>
    <div className="pb-2 text-center text-[10px] leading-5 text-white/35"><span className="font-bold text-white/60">How It Works</span><br/>Private rooms. No account needed.</div>
  </Screen>;
}

function EntryForm({ mode, loading, error, onBack, onSubmit }: {
  mode: "create" | "join"; loading: boolean; error: string | null; onBack: () => void;
  onSubmit: (payload: { action: "create"; name: string; avatar: number } | { action: "join"; name: string; code: string; avatar: number }) => void;
}) {
  const queryCode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "" : "";
  const [name, setName] = useState("");
  const [code, setCode] = useState(queryCode);
  const [avatar, setAvatar] = useState(mode === "create" ? 0 : 1);
  const valid = name.trim() && (mode === "create" || /^[A-Z0-9]{6}$/.test(code));
  return <Screen plum className="min-h-dvh px-6 pt-8">
    <button onClick={onBack} className="text-xs font-bold text-white/55">← Back</button>
    <div className="mt-6 text-center"><div className="eyebrow text-[var(--coral)]">{mode === "create" ? "1 of 2" : "Private room"}</div>
      <h1 className="headline mt-4 text-[28px] font-black">{mode === "create" ? <>First, what should<br/>your partner call you?</> : <>Join your<br/>favourite person</>}</h1>
      <p className="mt-3 text-xs text-[var(--muted)]">{mode === "create" ? "This is how you'll appear in the game." : "Enter the room code they shared with you."}</p>
    </div>
    <form className="mt-8 rounded-2xl border border-white/[.06] bg-white/[.045] p-5 shadow-xl" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      if (mode === "create") onSubmit({ action: "create", name: name.trim(), avatar });
      else onSubmit({ action: "join", name: name.trim(), code, avatar });
    }}>
      <div className="space-y-4">
        <Field label="Your name" value={name} maxLength={24} autoFocus placeholder="The Better Half" onChange={(e) => setName(e.target.value)} />
        {mode === "join" && <Field label="Room code" value={code} maxLength={6} inputMode="text" placeholder="LOVE42" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />}
        <div>
          <div className="mb-3 text-xs font-bold text-[var(--peach)]">Choose your look</div>
          <div className="flex gap-4">{[0,1,2,3].map((item) => <button type="button" aria-label={`Avatar ${item + 1}`} key={item} onClick={() => setAvatar(item)} className={`rounded-full p-1 ${avatar === item ? "bg-[var(--coral)]/20 ring-1 ring-[var(--coral)]" : "opacity-65"}`}><Avatar index={item}/></button>)}</div>
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      <Button className="mt-6" disabled={!valid || loading} type="submit">{loading ? "Opening your room…" : <span className="inline-flex items-center gap-2">{mode === "create" ? "Create Our Room" : "Join Their Room"}<ArrowRight size={15}/></span>}</Button>
    </form>
    <HowItWorks />
  </Screen>;
}

function HowItWorks() {
  const items = [[Eye, "See the secret word.", "Only one of you knows the target."], [MessageCircle, "Send short clues.", "One word per message. Keep it tight."], [Clipboard, "Watch your 15-word limit.", "Every word counts toward the total."], [RefreshCw, "Switch brains after Round 1.", "Roles reverse. Test your synergy."]] as const;
  return <section className="mt-8 px-2"><h2 className="mb-4 text-sm font-black text-[var(--peach)]">Relationship Telepathy 101</h2><div className="space-y-4">{items.map(([Icon,title,body]) => <div key={title} className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[.05] text-[var(--coral)]"><Icon size={13}/></span><div><div className="text-[11px] font-extrabold">{title}</div><div className="mt-0.5 text-[10px] text-[var(--muted)]">{body}</div></div></div>)}</div></section>;
}

function Lobby({ state, loading, error, mutate }: ScreenProps) {
  const you = state.players.find((p) => p.id === state.you.id)!;
  const partner = state.players.find((p) => p.id !== state.you.id);
  const inviteUrl = typeof window === "undefined" ? "" : `${window.location.origin}/?room=${state.code}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`I made us a 15 Words room 💫 Join me: ${inviteUrl}`)}`;
  return <Screen className="min-h-dvh px-5 pt-8">
    <div className="text-center"><h1 className="headline text-[22px] font-black text-[var(--peach)]">Your private room is ready</h1><p className="mt-2 text-[11px] text-[var(--muted)]">This room is just for the two of you.</p></div>
    <div className="mt-9 flex items-start justify-center gap-7">
      <PlayerSpot player={you} label="You" />
      <div className="mt-7 flex items-center gap-2"><span className="h-px w-6 bg-white/10"/><Heart size={11} color="var(--coral)" fill="var(--coral)"/><span className="h-px w-6 bg-white/10"/></div>
      {partner ? <PlayerSpot player={partner} label={partner.connected ? "Connected" : "Reconnecting…"} /> : <div className="text-center"><div className="grid size-[66px] place-items-center rounded-full border border-dashed border-[var(--coral)]/45"><MoreHorizontal className="text-white/35"/></div><div className="mt-3 text-[10px] text-[var(--muted)]">Waiting…</div></div>}
    </div>
    <div className="mt-9 rounded-xl border border-white/[.06] bg-white/[.035] p-5 text-center"><div className="eyebrow text-white/35">Room code</div><div className="mt-3 text-[25px] font-black tracking-[.12em] text-[var(--peach)]">{state.code}</div></div>
    {!partner && <div className="mt-5 space-y-3"><a href={whatsapp} target="_blank" rel="noreferrer" className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[var(--coral)] text-[12px] font-extrabold text-[#241115]"><Send size={14}/> Invite on WhatsApp</a><Button kind="secondary" onClick={copy}><span className="inline-flex items-center gap-2">{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? "Copied!" : "Copy Link"}</span></Button></div>}
    {partner && <div className="mt-6"><Button disabled={loading || you.ready} onClick={() => mutate({ action: "ready", ready: true })}>{you.ready ? "Waiting for your partner…" : "I'm Ready"}</Button><p className="mt-3 text-center text-[10px] text-white/35">The round begins when you’re both ready.</p></div>}
    {error && <ErrorNote message={error} />}
    <div className="absolute bottom-6 left-0 right-0 flex justify-center"><Brand compact /></div>
  </Screen>;
}

function PlayerSpot({ player, label }: { player: GameState["players"][number]; label: string }) {
  return <div className="w-20 text-center"><div className="flex justify-center"><Avatar index={player.avatar} size="lg" active={player.connected}/></div><div className="mt-3 truncate text-[11px] font-bold">{player.name}</div><div className="mt-1 flex items-center justify-center gap-1 text-[9px] text-[var(--muted)]">{player.connected ? <Wifi size={9}/> : <WifiOff size={9}/>} {label}</div></div>;
}

type ScreenProps = { state: GameState; loading: boolean; error: string | null; mutate: (payload: Record<string, unknown>) => Promise<GameState | undefined> };

function Play({ state, loading, error, mutate, feedback }: ScreenProps & { feedback: GuessFeedback | null }) {
  const [seconds, setSeconds] = useState(() => state.roundEndsAt ? (new Date(state.roundEndsAt).getTime() - Date.now()) / 1000 : 0);
  useEffect(() => {
    const tick = () => setSeconds(state.roundEndsAt ? (new Date(state.roundEndsAt).getTime() - Date.now()) / 1000 : 0);
    tick(); const id = window.setInterval(tick, 250); return () => window.clearInterval(id);
  }, [state.roundEndsAt]);
  const expiredRef = useRef(false);
  useEffect(() => { if (seconds <= 0 && !expiredRef.current) { expiredRef.current = true; void mutate({ action: "expire" }); } }, [seconds, mutate]);
  const giver = state.players.find((p) => p.id === state.round?.giverId)!;
  const guesser = state.players.find((p) => p.id === state.round?.guesserId)!;
  return <Screen className="min-h-dvh overflow-y-auto">
    <GameHeader state={state} seconds={seconds}/>
    <div className="px-5 pt-5">
      <div className="flex items-center justify-center gap-4"><Avatar index={giver.avatar} size="sm" active/><div className="h-px w-16 bg-gradient-to-r from-[var(--coral)] to-white/10"/><Avatar index={guesser.avatar} size="sm" active/></div>
      <p className="mt-3 text-center text-[10px] italic text-[var(--muted)]">{state.you.roundRole === "giver" ? `${guesser.name} is waiting for your clue…` : `${giver.name} is thinking of clues…`}</p>
      <GuessFeedbackBanner feedback={feedback} role={state.you.roundRole} guesserName={guesser.name}/>
      <div className="mt-5 text-center"><div className="text-[23px] font-black text-[var(--peach)]">{CLUE_WORD_LIMIT - state.cluesUsed} words left</div><div className="mx-auto mt-3 flex max-w-56 gap-1">{Array.from({ length: CLUE_WORD_LIMIT }).map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < CLUE_WORD_LIMIT - state.cluesUsed ? "bg-[var(--coral)]" : "bg-white/10"}`}/>)}</div></div>
      {state.you.roundRole === "giver" ? <GiverPanel state={state} loading={loading} mutate={mutate}/> : <GuesserPanel state={state} loading={loading} mutate={mutate}/>}
      {error && <ErrorNote message={error} />}
    </div>
  </Screen>;
}

function GameHeader({ state, seconds }: { state: GameState; seconds: number }) {
  return <header className="border-b border-white/[.06] bg-[var(--plum)]/75 px-5 pb-3 pt-4 backdrop-blur">
    <div className="grid grid-cols-3 items-center"><div className="eyebrow">Round {state.currentRound}</div><div className={`text-center font-mono text-sm font-bold ${seconds < 15 ? "text-[var(--coral)]" : "text-[var(--peach)]"}`}>{formatClock(seconds)}</div><div className="justify-self-end rounded-full border border-white/10 bg-white/[.05] px-2.5 py-1 text-[10px] font-black text-[var(--peach)]">{state.round?.score ?? 0} pts</div></div>
    <div className="mt-3 flex gap-1">{Array.from({ length: WORDS_PER_ROUND }).map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < state.currentWordIndex ? "bg-[var(--coral)]" : i === state.currentWordIndex ? "bg-[var(--peach)]" : "bg-white/10"}`}/>)}</div>
  </header>;
}

function GiverPanel({ state, loading, mutate }: Pick<ScreenProps, "state" | "loading" | "mutate">) {
  const [clue, setClue] = useState("");
  const word = state.round?.words[state.currentWordIndex]?.word ?? "";
  const used = countClueWords(clue);
  const send = async (event: React.FormEvent) => { event.preventDefault(); if (!clue.trim()) return; const result = await mutate({ action: "clue", clue }); if (result) setClue(""); };
  return <div className="mt-6">
    <div className="rounded-xl border border-[var(--coral)]/25 bg-[var(--plum)] px-5 py-5 text-center soft-glow"><div className="eyebrow text-white/35">Make them guess</div><div className="mt-3 text-[24px] font-black tracking-wide">{word.toUpperCase()}</div></div>
    {state.round?.latestClue && <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-400/10 px-3 py-2 text-[10px] font-bold text-emerald-300"><Check size={12}/> Sent: “{state.round.latestClue}”</div>}
    <form onSubmit={send} className="mt-4"><div className="relative"><input aria-label="Your clue" value={clue} maxLength={100} onChange={(e) => setClue(e.target.value)} placeholder="Type your clue…" className="h-13 w-full rounded-xl border border-white/10 bg-white/[.045] pl-4 pr-14 text-sm outline-none placeholder:text-white/25 focus:border-[var(--coral)]/50"/><button aria-label="Send clue" disabled={loading || !clue.trim() || used + state.cluesUsed > CLUE_WORD_LIMIT} className="absolute right-2 top-2 grid size-9 place-items-center rounded-lg bg-[var(--coral)] text-[#241115] disabled:opacity-35"><Send size={16}/></button></div><div className="mt-2 text-right text-[9px] text-white/30">{used} clue {used === 1 ? "word" : "words"}</div></form>
    <Button kind="ghost" className="mt-4" disabled={loading} onClick={() => mutate({ action: "skip" })}><span className="inline-flex items-center gap-2"><SkipForward size={14}/> Skip Word</span></Button>
  </div>;
}

function GuesserPanel({ state, loading, mutate }: Pick<ScreenProps, "state" | "loading" | "mutate">) {
  const [guess, setGuess] = useState("");
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!guess.trim()) return; const result = await mutate({ action: "guess", guess }); if (result) setGuess(""); };
  return <div className="mt-6">
    <div className="relative overflow-hidden rounded-2xl border border-white/[.06] bg-white/[.035] p-6 text-center subtle-grid"><EyeOff size={18} className="mx-auto text-white/25"/><div className="eyebrow mt-4 text-white/30">Latest clue</div><div className="mt-3 min-h-9 text-[25px] font-black text-[var(--peach)]">{state.round?.latestClue ? `“${state.round.latestClue}”` : "Waiting…"}</div></div>
    <form onSubmit={submit} className="mt-5"><div className="relative"><input aria-label="Your guess" value={guess} maxLength={60} onChange={(e) => setGuess(e.target.value)} placeholder="What’s the word?" className="h-13 w-full rounded-xl border border-white/10 bg-white/[.045] pl-4 pr-14 text-sm outline-none placeholder:text-white/25 focus:border-[var(--coral)]/50"/><button aria-label="Submit guess" disabled={loading || !guess.trim()} className="absolute right-2 top-2 grid size-9 place-items-center rounded-lg bg-[var(--coral)] text-[#241115] disabled:opacity-35"><ArrowRight size={16}/></button></div></form>
    <div className="mt-5 flex items-center justify-center gap-2 text-[10px] text-white/30"><Info size={11}/> Say it out loud or type it here</div>
  </div>;
}

function GuessFeedbackBanner({ feedback, role, guesserName }: { feedback: GuessFeedback | null; role: GameState["you"]["roundRole"]; guesserName: string }) {
  if (!feedback) return <div className="h-0" aria-live="polite"/>;
  const correct = feedback.kind === "correct";
  const message = correct
    ? "That’s it — one point closer!"
    : role === "giver"
      ? `${guesserName} guessed “${feedback.guess || "something else"}” — not quite`
      : "Not quite — keep going!";
  return <div aria-live="assertive" className={`feedback-pop relative mt-4 overflow-hidden rounded-xl border px-4 py-3 text-center text-[12px] font-black ${correct ? "border-emerald-300/30 bg-emerald-400/15 text-emerald-200" : "wrong-shake border-[var(--coral)]/35 bg-[var(--coral)]/12 text-[var(--peach)]"}`}>
    {correct && <div aria-hidden className="pointer-events-none absolute inset-0"><span className="reward-spark left-[18%]">♥</span><span className="reward-spark left-1/2 [animation-delay:80ms]">✦</span><span className="reward-spark left-[78%] [animation-delay:160ms]">♥</span></div>}
    <span className="relative inline-flex items-center gap-2">{correct ? <Sparkles size={14}/> : <Info size={14}/>} {message}</span>
  </div>;
}

function RoundResult({ state, loading, error, mutate }: ScreenProps) {
  const you = state.players.find((p) => p.id === state.you.id)!;
  const score = state.round?.score ?? 0;
  return <Screen className="min-h-dvh px-5 pt-8">
    <div className="flex justify-center"><Brand compact/></div>
    <div className="mt-10 text-center"><div className="mx-auto grid size-16 place-items-center rounded-full border border-[var(--coral)]/30 bg-[var(--coral)]/10 text-[var(--coral)]"><Heart size={25} fill="currentColor"/></div><h1 className="headline mt-5 text-[25px] font-black">You survived Round {state.currentRound}</h1><div className="mt-2 text-[32px] font-black text-[var(--peach)]">{score}<span className="ml-2 text-xs text-[var(--muted)]">points</span></div></div>
    <div className="mt-7 grid grid-cols-2 gap-3"><Stat value={`${score} of 8`} label="guessed"/><Stat value={`${CLUE_WORD_LIMIT - state.cluesUsed}`} label="clues left"/></div>
    <div className="mt-5 rounded-xl border border-white/[.06] bg-white/[.035] p-4"><div className="eyebrow mb-3 text-white/35">Breakdown</div><div className="space-y-2">{state.round?.words.map((item) => <div key={item.index} className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2"><span className="text-[11px] font-bold">{item.word}</span><span className={`text-[9px] font-bold ${item.status === "guessed" ? "text-emerald-300" : "text-white/35"}`}>{item.status === "guessed" ? "✓ Got it" : "Skipped"}</span></div>)}</div></div>
    <Button className="mt-5" disabled={loading || you.ready} onClick={() => mutate({ action: "continue" })}>{you.ready ? "Waiting for your partner…" : state.currentRound === 1 ? <span className="inline-flex items-center gap-2"><RefreshCw size={14}/> Switch Roles</span> : "See Our Results"}</Button>
    {error && <ErrorNote message={error}/>}<p className="mt-3 text-center text-[10px] text-white/30">{state.currentRound === 1 ? "Round 2 flips the clue giver and guesser." : "Your final score combines both rounds."}</p>
  </Screen>;
}

function FinalResult({ state, loading, error, mutate }: ScreenProps) {
  const total = state.players.reduce((sum, player) => sum + player.round1Score + player.round2Score, 0);
  const message = total >= 13 ? "Basically telepathic" : total >= 9 ? "On the same wavelength" : total >= 5 ? "Getting delightfully closer" : "Beautifully unpredictable";
  const you = state.players.find((p) => p.id === state.you.id)!;
  return <Screen plum className="min-h-dvh px-5 pt-8">
    <div className="flex justify-center"><Brand compact/></div>
    <div className="mt-9 text-center"><div className="relative mx-auto grid size-28 place-items-center rounded-full border border-[var(--coral)]/25 bg-black/20 shadow-[0_0_55px_rgba(255,98,104,.2)]"><Heart size={38} fill="var(--coral)" color="var(--coral)"/><Sparkles className="absolute -right-2 top-1 text-[var(--peach)]" size={20}/></div><div className="eyebrow mt-7 text-[var(--coral)]">Your couple score</div><div className="headline mt-2 text-[56px] font-black">{total}<span className="text-lg text-white/30">/16</span></div><h1 className="mt-2 text-xl font-black text-[var(--peach)]">{message}</h1><p className="mx-auto mt-3 max-w-[290px] text-xs leading-5 text-[var(--muted)]">You made it through fifteen words, two roles, and a tiny bit of mind reading.</p></div>
    <div className="mt-7 rounded-2xl border border-white/[.07] bg-black/15 p-4"><div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-3 text-[11px]"><span className="text-white/35">Player</span><span className="text-white/35">Round 1</span><span className="text-white/35">Round 2</span>{state.players.map((player) => <div className="contents" key={player.id}><span className="flex items-center gap-2 font-bold"><Avatar index={player.avatar} size="sm"/>{player.name}</span><span className="self-center text-center font-black">{player.round1Score}</span><span className="self-center text-center font-black">{player.round2Score}</span></div>)}</div></div>
    <Button className="mt-6" disabled={loading || you.ready} onClick={() => mutate({ action: "play_again" })}>{you.ready ? "Waiting for your partner…" : <span className="inline-flex items-center gap-2"><RefreshCw size={14}/> Play Again</span>}</Button>
    {error && <ErrorNote message={error}/>}<button onClick={() => navigator.share?.({ title: "15 Words", text: `We scored ${total}/16 on 15 Words!`, url: window.location.href })} className="mt-4 flex w-full items-center justify-center gap-2 py-2 text-[11px] font-bold text-white/45"><Share2 size={13}/> Share our score</button>
  </Screen>;
}

function Stat({ value, label }: { value: string; label: string }) { return <div className="rounded-xl border border-white/[.06] bg-white/[.035] p-4 text-center"><div className="text-lg font-black text-[var(--peach)]">{value}</div><div className="eyebrow mt-1 text-white/30">{label}</div></div>; }
function ErrorNote({ message }: { message: string }) { return <div role="alert" className="mt-4 rounded-lg border border-[var(--coral)]/25 bg-[var(--coral)]/10 px-3 py-2 text-center text-[11px] font-semibold text-[var(--peach)]">{message}</div>; }
