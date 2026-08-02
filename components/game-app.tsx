"use client";

import {
  ArrowRight, Check, Clipboard, Copy, Eye, EyeOff, Heart, House, Info,
  MessageCircle, MoreHorizontal, RefreshCw, Send, Share2, SkipForward, Sparkles,
  Users, Wifi, WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLUE_WORD_LIMIT, WORDS_PER_ROUND } from "@/lib/game/constants";
import { countClueWords } from "@/lib/game/rules";
import { stateChangedEventSchema } from "@/lib/game/realtime";
import type { GameMessage, GameState, Session } from "@/lib/game/types";
import { getBrowserClient } from "@/lib/supabase/browser";
import { CosmicOrb } from "./cosmic-orb";
import { Avatar, Brand, Button, Field, Screen } from "./ui";

type EntryMode = "landing" | "create" | "join";
type GuessFeedback = { id: number; kind: "wrong" | "correct"; guess?: string };
type CluePrompt = { id: number; kind: "request" | "offer" };

class ApiError extends Error {
  constructor(message: string, public code?: string, public state?: GameState, public definitive = true) { super(message); }
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.error || "Something went wrong", body.code, body.state);
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError("The connection timed out. Please try again.", undefined, undefined, false);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
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
  const [cluePrompt, setCluePrompt] = useState<CluePrompt | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<GameMessage[]>([]);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getBrowserClient>>["channel"]> | null>(null);
  const channelReadyRef = useRef(false);
  const typingStopRef = useRef<number | null>(null);
  const partnerTypingStopRef = useRef<number | null>(null);
  const lastTypingSentRef = useRef(0);
  const syncReconcileRef = useRef<number | null>(null);
  const lastSyncFetchRef = useRef(0);
  const lastObservedMessageRef = useRef<string | null>(null);
  const observedRoomRef = useRef<string | null>(null);
  const lastPromptedMessageRef = useRef<string | null>(null);
  const pendingActionRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const showFeedback = useCallback((event: Omit<GuessFeedback, "id">) => {
    const next = { ...event, id: Date.now() };
    setFeedback(next);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(event.kind === "correct" ? [35, 30, 70] : [45, 35, 45]);
    }
    window.setTimeout(() => setFeedback((current) => current?.id === next.id ? null : current), event.kind === "correct" ? 2200 : 6500);
  }, []);

  const fetchState = useCallback(async (activeSession: Session, quiet = false) => {
    try {
      const result = await requestJson<{ state: GameState }>(`/api/game?code=${activeSession.code}&playerId=${activeSession.playerId}`, {
        headers: { "x-player-token": activeSession.token }, cache: "no-store",
      });
      const latestMessage = result.state.messages.at(-1);
      if (latestMessage?.senderId !== activeSession.playerId
          && (latestMessage?.type === "clue_request" || latestMessage?.type === "clue_offer")
          && latestMessage.id !== lastPromptedMessageRef.current) {
        lastPromptedMessageRef.current = latestMessage.id;
        setCluePrompt({ id: Date.now(), kind: latestMessage.type === "clue_request" ? "request" : "offer" });
      } else if (latestMessage?.type !== "clue_request" && latestMessage?.type !== "clue_offer") {
        setCluePrompt(null);
      }
      const previousMessageId = lastObservedMessageRef.current;
      const hasObservedRoom = observedRoomRef.current === result.state.roomId;
      if (hasObservedRoom && latestMessage?.id !== previousMessageId) {
        const previousIndex = result.state.messages.findIndex((message) => message.id === previousMessageId);
        const incoming = result.state.messages.slice(previousIndex + 1);
        const resolution = incoming.findLast((message) => message.type === "wrong" || message.type === "correct");
        if (resolution) {
          const guess = resolution.type === "wrong"
            ? incoming.findLast((message) => message.type === "guess" && message.wordIndex === resolution.wordIndex)?.body ?? undefined
            : undefined;
          showFeedback({ kind: resolution.type === "wrong" ? "wrong" : "correct", ...(guess ? { guess } : {}) });
        }
      }
      observedRoomRef.current = result.state.roomId;
      lastObservedMessageRef.current = latestMessage?.id ?? null;
      setState((current) => current && current.roomId === result.state.roomId && current.version > result.state.version ? current : result.state);
      if (!quiet) setError(null);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "Could not load the room");
    }
  }, [showFeedback]);

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
      .on("broadcast", { event: "state_changed" }, ({ payload }) => {
        const parsed = stateChangedEventSchema.safeParse(payload);
        if (!parsed.success || parsed.data.actorId === session.playerId) return;
        setPartnerTyping(false);
        if (syncReconcileRef.current) return;
        const delay = Math.max(0, 500 - (Date.now() - lastSyncFetchRef.current));
        syncReconcileRef.current = window.setTimeout(() => {
          syncReconcileRef.current = null;
          lastSyncFetchRef.current = Date.now();
          void fetchState(session, true);
        }, delay);
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (payload?.from === session.playerId) return;
        if (payload?.active === false) {
          setPartnerTyping(false);
          if (partnerTypingStopRef.current) window.clearTimeout(partnerTypingStopRef.current);
          return;
        }
        if (payload?.active === true) {
          setPartnerTyping(true);
          if (partnerTypingStopRef.current) window.clearTimeout(partnerTypingStopRef.current);
          partnerTypingStopRef.current = window.setTimeout(() => setPartnerTyping(false), 1400);
        }
      })
      .on("presence", { event: "sync" }, () => {
        const presence = channel.presenceState<{ playerId: string }>();
        const ids = Object.values(presence).flat().map((item) => item.playerId).filter(Boolean);
        setConnectedIds(new Set(ids));
      })
      .subscribe(async (status) => {
        channelReadyRef.current = status === "SUBSCRIBED";
        if (status === "SUBSCRIBED") {
          await channel.track({ playerId: session.playerId, name: session.name, role: session.role, joinedAt: new Date().toISOString() });
          void fetchState(session, true);
        }
      });
    return () => { channelReadyRef.current = false; channelRef.current = null; void supabase.removeChannel(channel); };
  }, [fetchState, session, showFeedback, state?.roomId]);

  useEffect(() => () => {
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    if (partnerTypingStopRef.current) window.clearTimeout(partnerTypingStopRef.current);
    if (syncReconcileRef.current) window.clearTimeout(syncReconcileRef.current);
  }, []);

  const roomId = state?.roomId;
  useEffect(() => {
    if (!session || !roomId) return;
    const reconcile = () => { if (document.visibilityState === "visible") void fetchState(session, true); };
    const timer = window.setInterval(reconcile, 30000);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
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
    const fingerprint = JSON.stringify(payload);
    const actionId = pendingActionRef.current?.fingerprint === fingerprint
      ? pendingActionRef.current.id
      : crypto.randomUUID();
    pendingActionRef.current = { fingerprint, id: actionId };
    const optimisticType = typeof payload.action === "string" && ["clue", "guess", "clue_request", "clue_offer"].includes(payload.action) ? payload.action as GameMessage["type"] : null;
    const optimisticId = optimisticType ? `pending-${Date.now()}` : null;
    if (optimisticType && optimisticId && state) {
      const body = optimisticType === "clue" ? String(payload.clue ?? "") : optimisticType === "guess" ? String(payload.guess ?? "") : optimisticType === "clue_request" ? "Another clue, please?" : "Want another clue?";
      setOptimisticMessages((current) => [...current, {
        id: optimisticId, senderId: session.playerId, wordIndex: state.currentWordIndex,
        type: optimisticType, body, wordCount: optimisticType === "clue" ? countClueWords(body) : 0,
        createdAt: new Date().toISOString(), pending: true,
      }]);
    }
    setLoading(true); setError(null);
    if (payload.action === "guess") setFeedback(null);
    if (payload.action === "clue" || payload.action === "skip") setCluePrompt(null);
    try {
      const result = await requestJson<{ state: GameState }>("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json", "x-player-id": session.playerId, "x-player-token": session.token },
        body: JSON.stringify({ ...payload, actionId, code: session.code }),
      });
      pendingActionRef.current = null;
      lastObservedMessageRef.current = result.state.messages.at(-1)?.id ?? null;
      setState((current) => current && current.roomId === result.state.roomId && current.version > result.state.version ? current : result.state);
      if (payload.action === "guess") {
        const event = { kind: "correct" as const };
        showFeedback(event);
      }
      return result.state;
    } catch (cause) {
      if (cause instanceof ApiError && cause.definitive) pendingActionRef.current = null;
      if (!(cause instanceof ApiError) || !cause.definitive) await fetchState(session, true);
      if (cause instanceof ApiError && cause.code === "WRONG_GUESS") {
        const event = { kind: "wrong" as const, guess: typeof payload.guess === "string" ? payload.guess : undefined };
        showFeedback(event);
        if (cause.state) {
          lastObservedMessageRef.current = cause.state.messages.at(-1)?.id ?? null;
          setState(cause.state);
        }
        else await fetchState(session, true);
      } else setError(cause instanceof Error ? cause.message : "That did not work");
    }
    finally {
      if (optimisticId) setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticId));
      setLoading(false);
    }
  };

  const sendClueSignal = (kind: "request" | "offer") => {
    void mutate({ action: kind === "request" ? "clue_request" : "clue_offer" });
  };

  const stopTyping = () => {
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = null;
    if (channelReadyRef.current) void channelRef.current?.send({ type: "broadcast", event: "typing", payload: { active: false, from: session?.playerId } });
  };

  const signalTyping = () => {
    const now = Date.now();
    if (now - lastTypingSentRef.current > 450) {
      lastTypingSentRef.current = now;
      if (channelReadyRef.current) void channelRef.current?.send({ type: "broadcast", event: "typing", payload: { active: true, from: session?.playerId } });
    }
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = window.setTimeout(stopTyping, 900);
  };

  const goHome = () => {
    stopTyping();
    setSession(null);
    setState(null);
    setEntry("landing");
    setFeedback(null);
    setCluePrompt(null);
    setPartnerTyping(false);
    setOptimisticMessages([]);
    pendingActionRef.current = null;
    observedRoomRef.current = null;
    lastObservedMessageRef.current = null;
    lastPromptedMessageRef.current = null;
    setError(null);
    window.history.replaceState(null, "", "/");
  };

  if (booting) return <Screen><div className="grid min-h-dvh place-items-center"><Brand /></div></Screen>;
  if (!session || !state) {
    if (entry === "landing") return <Landing onCreate={() => setEntry("create")} onJoin={() => setEntry("join")} />;
    return <EntryForm mode={entry} loading={loading} error={error} onBack={() => { setEntry("landing"); setError(null); }} onSubmit={submitEntry} />;
  }

  const enriched = { ...state, messages: [...state.messages, ...optimisticMessages], players: state.players.map((p) => ({ ...p, connected: connectedIds.has(p.id) || p.id === session.playerId })) };
  if (state.status === "lobby") return <Lobby state={enriched} loading={loading} error={error} mutate={mutate} onHome={goHome} />;
  if (state.status === "playing") return <Play state={enriched} loading={loading} error={error} mutate={mutate} feedback={feedback} cluePrompt={cluePrompt} partnerTyping={partnerTyping} onClueSignal={sendClueSignal} onTyping={signalTyping} onStopTyping={stopTyping} onHome={goHome} clearFeedback={() => setFeedback(null)} clearCluePrompt={() => setCluePrompt(null)} />;
  if (state.status === "round_result") return <RoundResult state={enriched} loading={loading} error={error} mutate={mutate} onHome={goHome} />;
  return <FinalResult state={enriched} loading={loading} error={error} mutate={mutate} onHome={goHome} />;
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
          <div className="flex gap-4">{[0,1,2,3].map((item) => <button type="button" aria-label={`Avatar ${item + 1}`} aria-pressed={avatar === item} key={item} onClick={() => setAvatar(item)} className={`rounded-full p-1 ${avatar === item ? "bg-[var(--coral)]/20 ring-1 ring-[var(--coral)]" : "opacity-65"}`}><Avatar index={item}/></button>)}</div>
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      <Button className="mt-6" disabled={!valid || loading} type="submit">{loading ? "Opening your room…" : <span className="inline-flex items-center gap-2">{mode === "create" ? "Create Our Room" : "Join Their Room"}<ArrowRight size={15}/></span>}</Button>
    </form>
    <HowItWorks />
  </Screen>;
}

function HowItWorks() {
  const items = [[Eye, "See the secret word.", "Only one of you knows the target."], [MessageCircle, "Send short clues.", "Every clue can contain one or more words."], [Clipboard, "Watch your 15-word limit.", "Every word counts toward the total."], [RefreshCw, "Switch brains after Round 1.", "Roles reverse. Test your synergy."]] as const;
  return <section className="mt-8 px-2"><h2 className="mb-4 text-sm font-black text-[var(--peach)]">Relationship Telepathy 101</h2><div className="space-y-4">{items.map(([Icon,title,body]) => <div key={title} className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[.05] text-[var(--coral)]"><Icon size={13}/></span><div><div className="text-[11px] font-extrabold">{title}</div><div className="mt-0.5 text-[10px] text-[var(--muted)]">{body}</div></div></div>)}</div></section>;
}

function Lobby({ state, loading, error, mutate, onHome }: ScreenProps) {
  const you = state.players.find((p) => p.id === state.you.id)!;
  const partner = state.players.find((p) => p.id !== state.you.id);
  const inviteUrl = typeof window === "undefined" ? "" : `${window.location.origin}/?room=${state.code}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`I made us a 15 Words room 💫 Join me: ${inviteUrl}`)}`;
  return <Screen className="min-h-dvh px-5 pt-8">
    <HomeButton onClick={onHome}/>
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

type ScreenProps = { state: GameState; loading: boolean; error: string | null; mutate: (payload: Record<string, unknown>) => Promise<GameState | undefined>; onHome: () => void };

function Play({ state, loading, error, mutate, onHome, feedback, cluePrompt, partnerTyping, onClueSignal, onTyping, onStopTyping, clearFeedback, clearCluePrompt }: ScreenProps & {
  feedback: GuessFeedback | null;
  cluePrompt: CluePrompt | null;
  onClueSignal: (kind: "request" | "offer") => void;
  clearFeedback: () => void;
  clearCluePrompt: () => void;
  partnerTyping: boolean;
  onTyping: () => void;
  onStopTyping: () => void;
}) {
  const giver = state.players.find((p) => p.id === state.round?.giverId)!;
  const guesser = state.players.find((p) => p.id === state.round?.guesserId)!;
  const [confirmHome, setConfirmHome] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [state.messages.length, feedback, cluePrompt, partnerTyping]);
  return <Screen className="flex h-dvh min-h-dvh flex-col overflow-hidden">
    <GameHeader state={state} onHome={() => setConfirmHome(true)}/>
    <SecretWordStrip state={state}/>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <ChatTimeline state={state}/>
      <CluePromptBanner prompt={cluePrompt} role={state.you.roundRole} giverName={giver.name} guesserName={guesser.name} onAccept={() => { clearCluePrompt(); onClueSignal("request"); }} onDismiss={clearCluePrompt}/>
      <GuessFeedbackBanner feedback={feedback} role={state.you.roundRole} guesserName={guesser.name} onAskAnother={() => { clearFeedback(); onClueSignal("request"); }} onDismiss={clearFeedback}/>
      <div className="mt-3 flex min-h-6 items-center">{partnerTyping && <TypingIndicator name={state.you.roundRole === "giver" ? guesser.name : giver.name}/>}</div>
      {error && <ErrorNote message={error} />}
      <div ref={chatEndRef}/>
    </div>
    <div className="border-t border-white/[.07] bg-[var(--plum)]/80 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
      <ClueBudget used={state.cluesUsed}/>
      {state.you.roundRole === "giver" ? <GiverComposer state={state} loading={loading} mutate={mutate} clueRequested={cluePrompt?.kind === "request"} onOfferClue={() => onClueSignal("offer")} onTyping={onTyping} onStopTyping={onStopTyping}/> : <GuesserComposer loading={loading} mutate={mutate} onRequestClue={() => onClueSignal("request")} onTyping={onTyping} onStopTyping={onStopTyping}/>}
    </div>
    {confirmHome && <LeaveGameDialog onStay={() => setConfirmHome(false)} onLeave={onHome}/>}
  </Screen>;
}

function GameHeader({ state, onHome }: { state: GameState; onHome: () => void }) {
  return <header className="border-b border-white/[.06] bg-[var(--plum)]/75 px-5 pb-3 pt-4 backdrop-blur">
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3"><button aria-label="Go to home" onClick={onHome} className="grid size-11 place-items-center rounded-xl border border-white/10 bg-white/[.05] text-white/55"><House size={15}/></button><div className="text-center"><div className="eyebrow">Round {state.currentRound}</div><div className="mt-0.5 text-[10px] font-bold text-white/40">Take your time</div></div><div className="rounded-full border border-white/10 bg-white/[.05] px-2.5 py-1 text-[10px] font-black text-[var(--peach)]">{state.round?.score ?? 0} pts</div></div>
    <div className="mt-3 flex gap-1">{Array.from({ length: WORDS_PER_ROUND }).map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < state.currentWordIndex ? "bg-[var(--coral)]" : i === state.currentWordIndex ? "bg-[var(--peach)]" : "bg-white/10"}`}/>)}</div>
  </header>;
}

function GiverComposer({ state, loading, mutate, clueRequested, onOfferClue, onTyping, onStopTyping }: Pick<ScreenProps, "state" | "loading" | "mutate"> & { clueRequested: boolean; onOfferClue: () => void; onTyping: () => void; onStopTyping: () => void }) {
  const [clue, setClue] = useState("");
  const [offerSent, setOfferSent] = useState(false);
  const clueInputRef = useRef<HTMLInputElement>(null);
  const used = countClueWords(clue);
  useEffect(() => { if (clueRequested) clueInputRef.current?.focus(); }, [clueRequested]);
  const send = async (event: React.FormEvent) => { event.preventDefault(); if (!clue.trim()) return; onStopTyping(); const result = await mutate({ action: "clue", clue }); if (result) setClue(""); };
  const offer = () => {
    onOfferClue();
    setOfferSent(true);
    window.setTimeout(() => setOfferSent(false), 2200);
  };
  return <div>
    <form onSubmit={send}><div className="relative"><input ref={clueInputRef} aria-label="Your clue" value={clue} maxLength={100} onBlur={onStopTyping} onChange={(e) => { setClue(e.target.value); onTyping(); }} placeholder={clueRequested ? "They asked for another clue…" : "Message a clue…"} className={`h-12 w-full rounded-2xl border bg-black/25 pl-4 pr-14 text-sm outline-none placeholder:text-white/25 focus:border-[var(--coral)]/50 ${clueRequested ? "border-[var(--coral)]/70 soft-glow" : "border-white/10"}`}/><button aria-label="Send clue" disabled={loading || !clue.trim() || used + state.cluesUsed > CLUE_WORD_LIMIT} className="absolute right-0.5 top-0.5 grid size-11 place-items-center rounded-xl bg-[var(--coral)] text-[#241115] disabled:opacity-35"><Send size={16}/></button></div><div className="mt-1.5 flex items-center justify-between text-[10px] text-white/40"><span>Every clue word counts</span><span>{used} {used === 1 ? "word" : "words"}</span></div></form>
    <div className="mt-2 grid grid-cols-2 gap-2">{state.round?.latestClue && <button disabled={loading || offerSent || state.cluesUsed >= CLUE_WORD_LIMIT} onClick={offer} className="min-h-11 rounded-lg border border-[var(--coral)]/30 bg-[var(--coral)]/8 px-2 text-[10px] font-bold text-[var(--peach)] disabled:opacity-40"><span className="inline-flex items-center gap-1.5"><MessageCircle size={12}/>{offerSent ? "Offer Sent" : "Offer Another Clue"}</span></button>}<button disabled={loading} onClick={() => mutate({ action: "skip" })} className="min-h-11 rounded-lg border border-white/10 bg-white/[.04] px-2 text-[10px] font-bold text-white/50 disabled:opacity-40"><span className="inline-flex items-center gap-1.5"><SkipForward size={12}/>Try Another Word</span></button></div>
  </div>;
}

function GuesserComposer({ loading, mutate, onRequestClue, onTyping, onStopTyping }: Pick<ScreenProps, "loading" | "mutate"> & { onRequestClue: () => void; onTyping: () => void; onStopTyping: () => void }) {
  const [guess, setGuess] = useState("");
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!guess.trim()) return; onStopTyping(); const result = await mutate({ action: "guess", guess }); if (result) setGuess(""); };
  return <div>
    <form onSubmit={submit}><div className="relative"><input aria-label="Your guess" value={guess} maxLength={60} onBlur={onStopTyping} onChange={(e) => { setGuess(e.target.value); onTyping(); }} placeholder="Message your guess…" className="h-12 w-full rounded-2xl border border-white/10 bg-black/25 pl-4 pr-14 text-sm outline-none placeholder:text-white/25 focus:border-[var(--coral)]/50"/><button aria-label="Submit guess" disabled={loading || !guess.trim()} className="absolute right-0.5 top-0.5 grid size-11 place-items-center rounded-xl bg-[var(--coral)] text-[#241115] disabled:opacity-35"><ArrowRight size={16}/></button></div></form>
    <button onClick={onRequestClue} disabled={loading} className="mx-auto mt-2 flex min-h-11 items-center justify-center gap-1.5 px-3 text-[10px] font-bold text-white/50 disabled:opacity-40"><MessageCircle size={12}/>Ask for another clue</button>
  </div>;
}

function SecretWordStrip({ state }: { state: GameState }) {
  const word = state.round?.words[state.currentWordIndex]?.word;
  return <div className="border-b border-white/[.06] bg-black/20 px-4 py-2.5">
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-[10px] font-bold text-white/35"><span className="grid size-6 place-items-center rounded-full bg-white/[.05]">{state.you.roundRole === "giver" ? <Eye size={12}/> : <EyeOff size={12}/>}</span>Word {Math.min(state.currentWordIndex + 1, WORDS_PER_ROUND)} of {WORDS_PER_ROUND}</div><div className={`rounded-lg border px-3 py-1.5 text-[12px] font-black tracking-wide ${word ? "border-[var(--coral)]/25 bg-[var(--coral)]/10 text-[var(--peach)]" : "border-white/[.07] bg-white/[.035] text-white/25"}`}>{word?.toUpperCase() ?? "SECRET WORD"}</div></div>
  </div>;
}

function ClueBudget({ used }: { used: number }) {
  const remaining = CLUE_WORD_LIMIT - used;
  return <div className="mb-2 flex items-center gap-3"><span className="shrink-0 text-[9px] font-black text-[var(--peach)]">{remaining} clue words left</span><div className="flex flex-1 gap-0.5">{Array.from({ length: CLUE_WORD_LIMIT }).map((_, index) => <span key={index} className={`h-0.5 flex-1 rounded-full ${index < remaining ? "bg-[var(--coral)]" : "bg-white/10"}`}/>)}</div></div>;
}

function ChatTimeline({ state }: { state: GameState }) {
  const messages = state.messages ?? [];
  if (messages.length === 0) return <div className="mx-auto mt-4 max-w-64 rounded-xl border border-dashed border-white/10 px-4 py-3 text-center text-[10px] leading-4 text-white/30"><MessageCircle size={15} className="mx-auto mb-2"/>Your clues and guesses will appear here.</div>;
  return <div className="space-y-2.5">{messages.map((message, index) => {
    const previous = messages[index - 1];
    const showDivider = !previous || previous.wordIndex !== message.wordIndex;
    return <div key={message.id} className={message.wordIndex < state.currentWordIndex ? "opacity-55" : ""}>
      {showDivider && <div className="my-3 flex items-center gap-3"><span className="h-px flex-1 bg-white/[.06]"/><span className="eyebrow text-[8px] text-white/25">Word {message.wordIndex + 1}</span><span className="h-px flex-1 bg-white/[.06]"/></div>}
      <ChatMessageBubble message={message} state={state}/>
    </div>;
  })}</div>;
}

function ChatMessageBubble({ message, state }: { message: GameMessage; state: GameState }) {
  if (message.type === "wrong" || message.type === "correct" || message.type === "skipped") {
    const correct = message.type === "correct";
    const skipped = message.type === "skipped";
    return <div className={`mx-auto flex w-fit max-w-[86%] items-center gap-1.5 rounded-full border px-3 py-1.5 text-center text-[9px] font-black ${correct ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200" : skipped ? "border-white/10 bg-white/[.04] text-white/40" : "border-[var(--coral)]/20 bg-[var(--coral)]/8 text-[var(--peach)]"}`}>{correct ? <Check size={11}/> : skipped ? <SkipForward size={11}/> : <Info size={11}/>} {correct ? `Correct — ${message.body} · +1` : skipped ? `Moved on from ${message.body}` : "Not quite — keep going"}</div>;
  }
  const own = message.senderId === state.you.id;
  const sender = state.players.find((player) => player.id === message.senderId);
  const request = message.type === "clue_request" || message.type === "clue_offer";
  return <div className={`flex items-end gap-2 ${own ? "justify-end" : "justify-start"}`}>
    {!own && sender && <Avatar index={sender.avatar} size="sm"/>}
    <div className={`max-w-[76%] rounded-2xl px-3.5 py-2.5 ${own ? "rounded-br-md bg-[var(--coral)] text-[#271216]" : "rounded-bl-md border border-white/[.07] bg-white/[.065] text-[var(--ink)]"}`}>
      {!own && <div className="mb-1 text-[8px] font-black text-[var(--peach)]/65">{sender?.name}</div>}
      <div className="flex items-start gap-1.5 text-[12px] font-semibold leading-4">{request && <MessageCircle size={12} className="mt-0.5 shrink-0"/>}<span>{message.body}</span></div>
      <div className={`mt-1 text-[8px] ${own ? "text-black/40" : "text-white/25"}`}>{message.pending ? "Sending…" : message.type === "clue" ? `${message.wordCount} clue ${message.wordCount === 1 ? "word" : "words"}` : message.type === "guess" ? "Guess" : "Game request"}</div>
    </div>
  </div>;
}

function GuessFeedbackBanner({ feedback, role, guesserName, onAskAnother, onDismiss }: { feedback: GuessFeedback | null; role: GameState["you"]["roundRole"]; guesserName: string; onAskAnother: () => void; onDismiss: () => void }) {
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
    {!correct && role === "guesser" && <div className="relative mt-3 grid grid-cols-2 gap-2"><button onClick={onAskAnother} className="min-h-9 rounded-lg bg-[var(--coral)] px-2 text-[10px] font-black text-[#241115]">Ask for a clue</button><button onClick={onDismiss} className="min-h-9 rounded-lg border border-white/10 bg-black/15 px-2 text-[10px] font-bold text-white/60">Try again</button></div>}
  </div>;
}

function CluePromptBanner({ prompt, role, giverName, guesserName, onAccept, onDismiss }: {
  prompt: CluePrompt | null;
  role: GameState["you"]["roundRole"];
  giverName: string;
  guesserName: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const visible = prompt && ((prompt.kind === "request" && role === "giver") || (prompt.kind === "offer" && role === "guesser"));
  if (!visible) return null;
  const isRequest = prompt.kind === "request";
  return <div aria-live="assertive" className="feedback-pop mt-4 rounded-xl border border-[var(--peach)]/25 bg-[var(--plum)] px-4 py-3 text-center">
    <div className="flex items-center justify-center gap-2 text-[12px] font-black text-[var(--peach)]"><MessageCircle size={14}/>{isRequest ? `${guesserName} asked for another clue` : `${giverName} can give you another clue`}</div>
    {isRequest ? <p className="mt-1.5 text-[10px] text-white/45">Your clue box is ready below.</p> : <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={onAccept} className="min-h-9 rounded-lg bg-[var(--coral)] px-2 text-[10px] font-black text-[#241115]">Yes, please</button><button onClick={onDismiss} className="min-h-9 rounded-lg border border-white/10 bg-black/15 px-2 text-[10px] font-bold text-white/60">I’ll keep trying</button></div>}
  </div>;
}

function RoundResult({ state, loading, error, mutate, onHome }: ScreenProps) {
  const you = state.players.find((p) => p.id === state.you.id)!;
  const score = state.round?.score ?? 0;
  return <Screen className="min-h-dvh px-5 pt-8">
    <HomeButton onClick={onHome}/>
    <div className="flex justify-center"><Brand compact/></div>
    <div className="mt-10 text-center"><div className="mx-auto grid size-16 place-items-center rounded-full border border-[var(--coral)]/30 bg-[var(--coral)]/10 text-[var(--coral)]"><Heart size={25} fill="currentColor"/></div><h1 className="headline mt-5 text-[25px] font-black">You survived Round {state.currentRound}</h1><div className="mt-2 text-[32px] font-black text-[var(--peach)]">{score}<span className="ml-2 text-xs text-[var(--muted)]">points</span></div></div>
    <div className="mt-7 grid grid-cols-2 gap-3"><Stat value={`${score} of 8`} label="guessed"/><Stat value={`${CLUE_WORD_LIMIT - state.cluesUsed}`} label="clues left"/></div>
    <div className="mt-5 rounded-xl border border-white/[.06] bg-white/[.035] p-4"><div className="eyebrow mb-3 text-white/35">Breakdown</div><div className="space-y-2">{state.round?.words.map((item) => <div key={item.index} className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2"><span className="text-[11px] font-bold">{item.word}</span><span className={`text-[9px] font-bold ${item.status === "guessed" ? "text-emerald-300" : "text-white/35"}`}>{item.status === "guessed" ? "✓ Got it" : "Skipped"}</span></div>)}</div></div>
    <Button className="mt-5" disabled={loading || you.ready} onClick={() => mutate({ action: "continue" })}>{you.ready ? "Waiting for your partner…" : state.currentRound === 1 ? <span className="inline-flex items-center gap-2"><RefreshCw size={14}/> Switch Roles</span> : "See Our Results"}</Button>
    {error && <ErrorNote message={error}/>}<p className="mt-3 text-center text-[10px] text-white/30">{state.currentRound === 1 ? "Round 2 flips the clue giver and guesser." : "Your final score combines both rounds."}</p>
  </Screen>;
}

function FinalResult({ state, loading, error, mutate, onHome }: ScreenProps) {
  const total = state.players.reduce((sum, player) => sum + player.round1Score + player.round2Score, 0);
  const message = total >= 13 ? "Basically telepathic" : total >= 9 ? "On the same wavelength" : total >= 5 ? "Getting delightfully closer" : "Beautifully unpredictable";
  const you = state.players.find((p) => p.id === state.you.id)!;
  const [shared, setShared] = useState(false);
  const shareScore = async () => {
    const text = `We scored ${total}/16 on 15 Words!`;
    try {
      if (navigator.share) await navigator.share({ title: "15 Words", text, url: window.location.href });
      else await navigator.clipboard.writeText(`${text} ${window.location.href}`);
      setShared(true);
      window.setTimeout(() => setShared(false), 1800);
    } catch { /* The user may cancel the native share sheet. */ }
  };
  return <Screen plum className="min-h-dvh px-5 pt-8">
    <HomeButton onClick={onHome}/>
    <div className="flex justify-center"><Brand compact/></div>
    <div className="mt-9 text-center"><div className="relative mx-auto grid size-28 place-items-center rounded-full border border-[var(--coral)]/25 bg-black/20 shadow-[0_0_55px_rgba(255,98,104,.2)]"><Heart size={38} fill="var(--coral)" color="var(--coral)"/><Sparkles className="absolute -right-2 top-1 text-[var(--peach)]" size={20}/></div><div className="eyebrow mt-7 text-[var(--coral)]">Your couple score</div><div className="headline mt-2 text-[56px] font-black">{total}<span className="text-lg text-white/30">/16</span></div><h1 className="mt-2 text-xl font-black text-[var(--peach)]">{message}</h1><p className="mx-auto mt-3 max-w-[290px] text-xs leading-5 text-[var(--muted)]">You made it through sixteen secret words, two roles, and a tiny bit of mind reading.</p></div>
    <div className="mt-7 rounded-2xl border border-white/[.07] bg-black/15 p-4"><div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-3 text-[11px]"><span className="text-white/35">Player</span><span className="text-white/35">Round 1</span><span className="text-white/35">Round 2</span>{state.players.map((player) => <div className="contents" key={player.id}><span className="flex items-center gap-2 font-bold"><Avatar index={player.avatar} size="sm"/>{player.name}</span><span className="self-center text-center font-black">{player.round1Score}</span><span className="self-center text-center font-black">{player.round2Score}</span></div>)}</div></div>
    <Button className="mt-6" disabled={loading || you.ready} onClick={() => mutate({ action: "play_again" })}>{you.ready ? "Waiting for your partner…" : <span className="inline-flex items-center gap-2"><RefreshCw size={14}/> Play Again</span>}</Button>
    {error && <ErrorNote message={error}/>}<button onClick={shareScore} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 py-2 text-[11px] font-bold text-white/50"><Share2 size={13}/> {shared ? "Score copied!" : "Share our score"}</button>
  </Screen>;
}

function Stat({ value, label }: { value: string; label: string }) { return <div className="rounded-xl border border-white/[.06] bg-white/[.035] p-4 text-center"><div className="text-lg font-black text-[var(--peach)]">{value}</div><div className="eyebrow mt-1 text-white/30">{label}</div></div>; }
function ErrorNote({ message }: { message: string }) { return <div role="alert" className="mt-4 rounded-lg border border-[var(--coral)]/25 bg-[var(--coral)]/10 px-3 py-2 text-center text-[11px] font-semibold text-[var(--peach)]">{message}</div>; }

function HomeButton({ onClick }: { onClick: () => void }) {
  return <button aria-label="Go to home" onClick={onClick} className="absolute left-5 top-[max(1.25rem,env(safe-area-inset-top))] z-10 grid size-11 place-items-center rounded-xl border border-white/10 bg-white/[.05] text-white/55 transition active:scale-95"><House size={15}/></button>;
}

function TypingIndicator({ name }: { name: string }) {
  return <div role="status" aria-label={`${name} is typing`} className="typing-pop flex items-center gap-2 text-[10px] font-bold text-[var(--peach)]"><span>{name} is typing</span><span className="flex items-center gap-1 rounded-full bg-white/[.07] px-2 py-1"><i className="typing-dot"/><i className="typing-dot [animation-delay:140ms]"/><i className="typing-dot [animation-delay:280ms]"/></span></div>;
}

function LeaveGameDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const stayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stayRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onStay(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onStay]);
  return <div className="absolute inset-0 z-50 grid place-items-center bg-black/70 px-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="leave-game-title">
    <div className="w-full rounded-2xl border border-white/10 bg-[var(--plum)] p-5 text-center shadow-2xl">
      <div className="mx-auto grid size-11 place-items-center rounded-full bg-[var(--coral)]/12 text-[var(--coral)]"><House size={19}/></div>
      <h2 id="leave-game-title" className="mt-4 text-lg font-black">Go back home?</h2>
      <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">Your room stays saved on this device, so you can reopen the shared link and continue later.</p>
      <div className="mt-5 grid grid-cols-2 gap-3"><Button ref={stayRef} kind="ghost" onClick={onStay}>Stay Here</Button><Button onClick={onLeave}>Go Home</Button></div>
    </div>
  </div>;
}
