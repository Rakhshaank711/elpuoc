"use client";

import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Clock3, Copy,
  Crown, Eye, House, Layers3, LogOut, Play, RotateCcw, Send, Sparkles,
  ScrollText, Trophy, Users, Volume2, VolumeX, X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Field } from "./ui";
import { getBrowserClient } from "@/lib/supabase/browser";
import { calculateHandValue, getCardValue, rankIndex, SHOW_DECISION_SECONDS, validateDiscard } from "@/lib/yunuf/rules";
import type { Card, Suit, YunufGameEvent, YunufSession, YunufViewState } from "@/lib/yunuf/types";

type Entry = "landing" | "create" | "join";
type MotionPoint = { x: number; y: number };
type CardMotion = { id: string; card: Card | undefined; faceDown: boolean; large: boolean; kind: "discard" | "draw"; from: MotionPoint; via: MotionPoint; to: MotionPoint; delay: number; rotation: number };
const sessionKey = (code: string) => `yunuf:${code.toUpperCase()}`;
const suitSymbol: Record<Suit, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
const suitOrder: Record<Suit, number> = { hearts: 0, diamonds: 1, clubs: 2, spades: 3 };
const motionPoint = (element: HTMLElement | null, large = false): MotionPoint | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - (large ? 34 : 21.5), y: rect.top + rect.height / 2 - (large ? 48 : 31) };
};

class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function api<T>(url: string, options?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.error || "That move did not work.", response.status, body.code);
    return body as T;
  } finally { window.clearTimeout(timer); }
}

export function YunufApp() {
  const router = useRouter();
  const [entry, setEntry] = useState<Entry>("landing");
  const [session, setSession] = useState<YunufSession | null>(null);
  const [state, setState] = useState<YunufViewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [connectedIds, setConnectedIds] = useState(new Set<string>());
  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getBrowserClient>>["channel"]> | null>(null);
  const sessionRef = useRef<YunufSession | null>(null);
  const stateRef = useRef<YunufViewState | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);
  const syncQueuedSessionRef = useRef<YunufSession | null>(null);

  const applyState = useCallback((next: YunufViewState) => {
    if (sessionRef.current?.playerId !== next.you.id || sessionRef.current.code !== next.code) return false;
    const current = stateRef.current;
    if (current && current.roomId === next.roomId && current.version > next.version) return false;
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  const fetchState = useCallback(async (active: YunufSession, quiet = false) => {
    try {
      const result = await api<{ state: YunufViewState }>(`/api/yunuf?code=${active.code}&playerId=${active.playerId}`, { headers: { "x-player-token": active.token }, cache: "no-store" });
      if (sessionRef.current?.playerId !== active.playerId || sessionRef.current.token !== active.token) return;
      applyState(result.state);
      setSyncError(null);
      if (!quiet) setError(null);
      return result.state;
    } catch (cause) {
      if (sessionRef.current?.playerId !== active.playerId || sessionRef.current.token !== active.token) return;
      const message = cause instanceof Error ? cause.message : "Could not load Yunuf.";
      if (quiet) setSyncError("Connection interrupted. Reconnecting…");
      else setError(message);
    }
  }, [applyState]);

  const reconcile = useCallback(async (active: YunufSession) => {
    syncQueuedSessionRef.current = active;
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      while (syncQueuedSessionRef.current) {
        const next = syncQueuedSessionRef.current;
        syncQueuedSessionRef.current = null;
        await fetchState(next, true);
      }
    } finally { syncInFlightRef.current = false; }
  }, [fetchState]);

  const queueReconcile = useCallback((active: YunufSession, delay = 120) => {
    if (syncTimerRef.current !== null) return;
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      void reconcile(active);
    }, delay);
  }, [reconcile]);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("room")?.toUpperCase();
    if (!code) { queueMicrotask(() => setBooting(false)); return; }
    const stored = localStorage.getItem(sessionKey(code));
    if (!stored) { queueMicrotask(() => { setEntry("join"); setBooting(false); }); return; }
    try {
      const active = JSON.parse(stored) as YunufSession;
      sessionRef.current = active;
      queueMicrotask(() => { setSession(active); void fetchState(active).finally(() => setBooting(false)); });
    } catch { localStorage.removeItem(sessionKey(code)); queueMicrotask(() => setBooting(false)); }
  }, [fetchState]);

  useEffect(() => {
    if (!session || !state?.roomId) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(`yunuf:${state.roomId}`, { config: { presence: { key: session.playerId }, broadcast: { self: false } } });
    channelRef.current = channel;
    channel.on("broadcast", { event: "state_changed" }, ({ payload }) => {
      if (typeof payload?.actorId === "string" && payload.actorId !== session.playerId) queueReconcile(session);
    })
      .on("presence", { event: "sync" }, () => {
        const presence = channel.presenceState<{ playerId: string }>();
        setConnectedIds(new Set(Object.values(presence).flat().map((item) => item.playerId)));
      })
      .subscribe(async (status) => {
        const connected = status === "SUBSCRIBED";
        setRealtimeConnected(connected);
        if (connected) {
          await channel.track({ playerId: session.playerId, name: session.name, role: session.role, joinedAt: new Date().toISOString() });
          queueReconcile(session, 0);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setSyncError("Connection interrupted. Reconnecting…");
        }
      });
    const interval = window.setInterval(() => queueReconcile(session, 0), 4_000);
    const focus = () => { if (!document.hidden) queueReconcile(session, 0); };
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.clearInterval(interval);
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
      document.removeEventListener("visibilitychange", focus);
      channelRef.current = null;
      setRealtimeConnected(false);
      void supabase.removeChannel(channel);
    };
  }, [queueReconcile, session, state?.roomId]);

  const enter = async (payload: Record<string, unknown>) => {
    setLoading(true); setError(null);
    try {
      const result = await api<{ session: YunufSession }>("/api/yunuf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      localStorage.setItem(sessionKey(result.session.code), JSON.stringify(result.session));
      sessionRef.current = result.session;
      setSession(result.session);
      router.replace(`/games/yunuf?room=${result.session.code}`);
      await fetchState(result.session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not enter the room."); }
    finally { setLoading(false); }
  };

  const mutate = useCallback(async (payload: Record<string, unknown>) => {
    if (!session || !stateRef.current) return;
    setLoading(true); setError(null);
    try {
      const needsVersion = payload.action !== "ready";
      const expectedVersion = stateRef.current.version;
      const result = await api<{ state: YunufViewState }>("/api/yunuf", { method: "POST", headers: { "content-type": "application/json", "x-player-id": session.playerId, "x-player-token": session.token }, body: JSON.stringify({ ...payload, code: session.code, ...(needsVersion ? { expectedVersion, actionId: crypto.randomUUID() } : {}) }) });
      applyState(result.state);
      setSyncError(null);
      return result.state;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That move did not work.");
      if (cause instanceof ApiError && cause.status === 409 && await fetchState(session, true)) setError(null);
    } finally { setLoading(false); }
  }, [applyState, fetchState, session]);

  const loadLog = useCallback(async () => {
    if (!session) return [];
    const result = await api<{ events: YunufGameEvent[] }>(`/api/yunuf?code=${session.code}&playerId=${session.playerId}&view=log`, { headers: { "x-player-token": session.token }, cache: "no-store" });
    return result.events;
  }, [session]);
  const leave = () => { sessionRef.current = null; stateRef.current = null; syncQueuedSessionRef.current = null; setSession(null); setState(null); setError(null); setSyncError(null); router.push("/"); };
  if (booting) return <YunufShell><div className="grid min-h-dvh place-items-center"><YunufMark/></div></YunufShell>;
  if (!session || !state) {
    if (entry === "landing") return <YunufLanding onHome={() => router.push("/")} onCreate={() => setEntry("create")} onJoin={() => setEntry("join")}/>;
    return <YunufEntry mode={entry} loading={loading} error={error} onBack={() => setEntry("landing")} onSubmit={enter}/>;
  }
  const visibleError = error ?? syncError;
  const connectedState = { ...state, players: state.players.map((player) => ({ ...player, connected: connectedIds.has(player.id) || (player.id === session.playerId && realtimeConnected) })) };
  if (state.status === "lobby") return <YunufLobby state={connectedState} loading={loading} error={visibleError} mutate={mutate} leave={leave}/>;
  if (state.status === "hand_results") return <div className="relative"><YunufResults state={connectedState} loading={loading} mutate={mutate} leave={leave}/><GameLogLauncher state={connectedState} loadLog={loadLog}/></div>;
  if (state.status === "match_over") return <div className="relative"><YunufMatchOver state={connectedState} loading={loading} mutate={mutate} leave={leave}/><GameLogLauncher state={connectedState} loadLog={loadLog}/></div>;
  return <YunufTable state={connectedState} loading={loading} error={visibleError} mutate={mutate} leave={leave} loadLog={loadLog}/>;
}

function YunufShell({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <main className={`yunuf-shell min-h-dvh text-[#f8f1dc] ${className}`}>{children}</main>; }
function YunufMark() { return <div className="flex items-center gap-2.5 text-lg font-black tracking-[.06em] text-[#e8cf8a]"><span className="grid size-8 rotate-[-5deg] place-items-center rounded-lg bg-[#f8f1dc] text-[#18211e] shadow-lg">Y</span>YUNUF</div>; }

function YunufLanding({ onHome, onCreate, onJoin }: { onHome: () => void; onCreate: () => void; onJoin: () => void }) {
  return <YunufShell className="flex flex-col px-6 pb-7 pt-8"><div className="grid grid-cols-[44px_1fr_44px] items-center"><button aria-label="Back to all games" onClick={onHome} className="yunuf-icon-button"><ArrowLeft size={16}/></button><div className="flex justify-center"><YunufMark/></div><span/></div>
    <div className="flex flex-1 flex-col justify-center py-9"><div className="relative mx-auto h-48 w-60"><span className="absolute left-5 top-7 rotate-[-14deg]"><PlayingCard card={{ id: "hero-k", rank: "K", suit: "spades" }} decorative/></span><span className="absolute left-[88px] top-1 rotate-[2deg]"><PlayingCard card={{ id: "hero-a", rank: "A", suit: "hearts" }} decorative/></span><span className="absolute right-4 top-8 rotate-[15deg]"><PlayingCard card={{ id: "hero-2", rank: "2", suit: "clubs" }} decorative/></span><div className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full border border-[#d7b45a]/25 bg-[#d7b45a]/10 px-4 py-2 text-[9px] font-black tracking-[.14em] text-[#e8cf8a]">LOWEST HAND WINS</div></div>
      <div className="mt-8"><div className="yunuf-eyebrow">2–5 players · private room</div><h1 className="mt-3 text-[36px] font-black leading-[.96] tracking-[-.04em]">Drop cards.<br/>Risk the Show.<br/><span className="text-[#e8cf8a]">Survive the table.</span></h1><p className="mt-4 max-w-[340px] text-[12px] leading-5 text-white/45">Build pairs and wild mixed-suit runs. Keep your total low—and decide when everyone gets one final chance.</p></div>
      <div className="mt-7 space-y-3"><YunufButton onClick={onCreate}><Sparkles size={15}/>Create a room</YunufButton><YunufButton secondary onClick={onJoin}><Users size={15}/>Join a room</YunufButton></div>
    </div><p className="text-center text-[9px] text-white/25">No accounts · Five cards · One survivor</p></YunufShell>;
}

function YunufEntry({ mode, loading, error, onBack, onSubmit }: { mode: "create" | "join"; loading: boolean; error: string | null; onBack: () => void; onSubmit: (payload: Record<string, unknown>) => void }) {
  const query = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "";
  const [name, setName] = useState(""); const [code, setCode] = useState(query); const [avatar, setAvatar] = useState(mode === "create" ? 0 : 1); const [limit, setLimit] = useState(100); const [timer, setTimer] = useState(30);
  const valid = name.trim() && (mode === "create" || /^[A-Z0-9]{6}$/.test(code));
  return <YunufShell className="px-6 pb-8 pt-8"><button onClick={onBack} className="flex min-h-11 items-center gap-2 text-[11px] font-bold text-white/50"><ChevronLeft size={15}/>Back</button><div className="mt-6"><div className="yunuf-eyebrow">{mode === "create" ? "New table" : "Private table"}</div><h1 className="mt-3 text-[30px] font-black leading-tight">{mode === "create" ? "Take your seat." : "Join the table."}</h1><p className="mt-2 text-[11px] text-white/40">{mode === "create" ? "You’ll host up to four friends." : "Enter the six-character room code."}</p></div>
    <form className="mt-7 rounded-2xl border border-white/[.08] bg-black/20 p-5" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(mode === "create" ? { action: "create", name: name.trim(), avatar, eliminationScore: limit, turnDurationSeconds: timer } : { action: "join", name: name.trim(), avatar, code }); }}><Field label="Your name" value={name} maxLength={24} autoFocus placeholder="Rakh" onChange={(event) => setName(event.target.value)}/>{mode === "join" && <div className="mt-4"><Field label="Room code" value={code} maxLength={6} placeholder="YUNUF5" onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}/></div>}
      <div className="mt-5"><div className="mb-3 text-xs font-bold text-[#e8cf8a]">Choose your seat</div><div className="flex gap-4">{[0,1,2,3].map((item) => <button type="button" aria-label={`Avatar ${item + 1}`} aria-pressed={avatar === item} key={item} onClick={() => setAvatar(item)} className={`rounded-full p-1 ${avatar === item ? "bg-[#d7b45a]/20 ring-1 ring-[#d7b45a]" : "opacity-55"}`}><Avatar index={item}/></button>)}</div></div>
      {mode === "create" && <div className="mt-5 grid grid-cols-2 gap-3"><label className="text-[10px] font-bold text-[#e8cf8a]">Eliminate at<select aria-label="Elimination score" value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#121a18] px-3 text-xs text-white"><option value={25}>25 points</option><option value={50}>50 points</option><option value={100}>100 points</option><option value={150}>150 points</option></select></label><label className="text-[10px] font-bold text-[#e8cf8a]">Turn timer<select aria-label="Turn timer" value={timer} onChange={(event) => setTimer(Number(event.target.value))} className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#121a18] px-3 text-xs text-white"><option value={30}>30 sec</option><option value={45}>45 sec</option><option value={60}>60 sec</option></select></label></div>}
      {error && <YunufError message={error}/>}<YunufButton className="mt-6" disabled={!valid || loading} type="submit">{loading ? "Shuffling…" : mode === "create" ? "Create table" : "Join table"}<ArrowRight size={15}/></YunufButton></form></YunufShell>;
}

type GameProps = { state: YunufViewState; loading: boolean; mutate: (payload: Record<string, unknown>) => Promise<YunufViewState | undefined>; leave: () => void; error?: string | null; loadLog?: () => Promise<YunufGameEvent[]> };

function YunufLobby({ state, loading, mutate, leave, error }: GameProps) {
  const you = state.players.find((player) => player.id === state.you.id)!; const isHost = state.you.id === state.hostPlayerId; const allReady = state.players.length >= 2 && state.players.every((player) => player.ready);
  const invite = typeof window === "undefined" ? "" : `${window.location.origin}/games/yunuf?room=${state.code}`; const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return <YunufShell className="px-5 pb-8 pt-7"><div className="flex items-center justify-between"><button aria-label="Leave room" onClick={leave} className="yunuf-icon-button"><House size={15}/></button><YunufMark/><span className="rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-bold text-white/40">{state.players.length}/5</span></div><div className="mt-8 text-center"><div className="yunuf-eyebrow">Your private table</div><h1 className="mt-3 text-[28px] font-black">Waiting for players</h1><div className="mx-auto mt-5 w-fit rounded-xl border border-[#d7b45a]/20 bg-[#d7b45a]/8 px-8 py-4"><span className="text-[8px] font-black tracking-[.14em] text-white/35">ROOM CODE</span><div className="mt-1 text-[25px] font-black tracking-[.14em] text-[#e8cf8a]">{state.code}</div></div></div>
    <div className="mt-7 space-y-2">{state.players.map((player) => <div key={player.id} className="flex items-center gap-3 rounded-xl border border-white/[.07] bg-white/[.035] p-3"><Avatar index={player.avatar}/><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-black">{player.name}{player.id === state.hostPlayerId && <Crown className="ml-1.5 inline text-[#d7b45a]" size={11}/>}</div><div className="mt-1 text-[9px] text-white/35">Seat {player.seatIndex} · {player.connected ? "Connected" : "Reconnecting"}</div></div><span className={`rounded-full px-2.5 py-1 text-[8px] font-black ${player.ready ? "bg-emerald-400/10 text-emerald-200" : "bg-white/[.05] text-white/30"}`}>{player.ready ? "READY" : "WAITING"}</span></div>)}</div>
    {state.players.length < 5 && <div className="mt-5 grid grid-cols-2 gap-2"><a href={`https://wa.me/?text=${encodeURIComponent(`Join my Yunuf table: ${invite}`)}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#d7b45a] text-[10px] font-black text-[#18211e]"><Send size={13}/>WhatsApp</a><button onClick={copy} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 text-[10px] font-bold text-white/55">{copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? "Copied" : "Copy link"}</button></div>}
    <div className="mt-6 rounded-xl border border-white/[.06] bg-black/15 p-3 text-[9px] text-white/40"><div className="flex justify-between"><span>Elimination</span><b className="text-white/65">{state.eliminationScore} points</b></div><div className="mt-2 flex justify-between"><span>Turn timer</span><b className="text-white/65">{state.turnDurationSeconds} seconds</b></div></div>
    <div className="mt-5">{isHost ? <YunufButton disabled={loading || !allReady} onClick={() => mutate({ action: "start" })}><Play size={15}/>{allReady ? "Start match" : state.players.length < 2 ? "Invite at least one player" : "Waiting for everyone"}</YunufButton> : <YunufButton secondary disabled={loading || you.ready} onClick={() => mutate({ action: "ready", ready: true })}>{you.ready ? <><Check size={15}/>You’re ready</> : "Ready up"}</YunufButton>}{isHost && !you.ready && <button onClick={() => mutate({ action: "ready", ready: true })} className="mt-3 min-h-11 w-full text-[10px] font-bold text-white/45">Mark myself ready</button>}</div>{error && <YunufError message={error}/>}</YunufShell>;
}

function YunufTable({ state, loading, mutate, leave, error, loadLog }: GameProps) {
  const you = state.players.find((player) => player.id === state.you.id)!; const yourTurn = state.currentPlayerId === you.id; const [selected, setSelected] = useState<string[]>([]); const [departing, setDeparting] = useState<string[]>([]); const [incomingDraw, setIncomingDraw] = useState<{ card?: Card; faceDown: boolean; landed: boolean } | null>(null); const incomingTimer = useRef<number | null>(null); const [showLog, setShowLog] = useState(false); const [logEvents, setLogEvents] = useState<YunufGameEvent[]>([]); const [logLoading, setLogLoading] = useState(false); const [logError, setLogError] = useState<string | null>(null); const [muted, setMuted] = useState(true); const [order, setOrder] = useState(() => (you.hand ?? []).map((card) => card.id)); const [draggingCardId, setDraggingCardId] = useState<string | null>(null); const [dragTargetId, setDragTargetId] = useState<string | null>(null); const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const openLog = async () => { setShowLog(true); setLogLoading(true); setLogError(null); try { setLogEvents(await loadLog?.() ?? []); } catch (cause) { setLogError(cause instanceof Error ? cause.message : "Could not load the game history."); } finally { setLogLoading(false); } };
  const [motions, setMotions] = useState<CardMotion[]>([]); const motionSequence = useRef(0); const previousState = useRef<YunufViewState | null>(null); const playerStacks = useRef(new Map<string, HTMLDivElement>()); const handCards = useRef(new Map<string, HTMLButtonElement>()); const handAreaRef = useRef<HTMLDivElement>(null); const deckRef = useRef<HTMLButtonElement>(null); const discardRef = useRef<HTMLButtonElement>(null); const handDrag = useRef<{ cardId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null); const suppressCardClick = useRef(false);
  const hand = useMemo(() => [...(you.hand ?? [])].sort((left, right) => {
    const leftIndex = order.indexOf(left.id); const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }), [order, you.hand]);
  const activeSelected = selected.filter((id) => hand.some((card) => card.id === id));
  const selectedCards = activeSelected.map((id) => hand.find((card) => card.id === id)!).filter(Boolean) as Card[];
  const showDecisionActive = state.turnPhase === "decision" && state.completedRounds >= 3 && !state.showState.active;
  const canChooseShow = yourTurn && showDecisionActive;
  const decisionSubmitted = useRef<number | null>(null);
  const submitDecision = useCallback(async (action: "end_turn" | "declare_show") => {
    if (decisionSubmitted.current === state.version) return;
    decisionSubmitted.current = state.version;
    if (!await mutate({ action })) decisionSubmitted.current = null;
  }, [mutate, state.version]);
  const validation = validateDiscard(selectedCards); const topSelectedCard = selectedCards.at(-1); const topDiscardCard = state.drawSourceDiscard?.cards.at(-1) ?? null; const topDrawIsPending = Boolean(incomingDraw?.card && incomingDraw.card.id === topDiscardCard?.id); const displayedDiscardCard = topDrawIsPending ? state.drawSourceDiscard?.cards.at(-2) ?? null : topDiscardCard ?? state.latestDiscard?.cards.at(-1) ?? null; const visibleDrawPileCount = Math.max(0, state.drawPileCount - (incomingDraw?.faceDown ? 1 : 0)); const visibleHandValue = calculateHandValue(hand) + (incomingDraw?.landed && incomingDraw.card ? getCardValue(incomingDraw.card.rank) : 0);
  const beginIncomingDraw = (card: Card | undefined, faceDown: boolean) => { if (incomingTimer.current) window.clearTimeout(incomingTimer.current); setIncomingDraw({ card, faceDown, landed: false }); incomingTimer.current = window.setTimeout(() => setIncomingDraw((current) => current ? { ...current, landed: true } : null), 610); };
  const finishIncomingDraw = () => { if (incomingTimer.current) window.clearTimeout(incomingTimer.current); incomingTimer.current = null; setIncomingDraw(null); };
  useEffect(() => () => { if (incomingTimer.current) window.clearTimeout(incomingTimer.current); }, []);
  const animateTransfer = useCallback((cards: Array<Card | undefined>, faceDown: boolean, kind: CardMotion["kind"], fromElements: HTMLElement | Array<HTMLElement | null> | null, toElement: HTMLElement | null, extraDelay = 0, large = false) => {
    const sources = Array.isArray(fromElements) ? fromElements : cards.map(() => fromElements); const to = motionPoint(toElement, large);
    if (!to) return;
    const next = cards.map((card, index) => {
      const from = motionPoint(sources[index] ?? null, large); if (!from) return null;
      const spread = (index - (cards.length - 1) / 2) * (large ? 10 : 7);
      const id = `motion-${++motionSequence.current}`;
      return { id, card, faceDown, large, kind, from, via: { x: (from.x + to.x) / 2 + spread, y: (from.y + to.y) / 2 - (kind === "discard" ? 64 : 50) }, to: { x: to.x + spread, y: to.y }, delay: extraDelay + index * 80, rotation: (index - (cards.length - 1) / 2) * 7 } satisfies CardMotion;
    }).filter((motion): motion is CardMotion => Boolean(motion));
    setMotions((current) => [...current, ...next]);
  }, []);
  useEffect(() => {
    const before = previousState.current; previousState.current = state;
    if (!before || before.handNumber !== state.handNumber) return;
    const newDiscard = state.latestDiscard && state.latestDiscard.id !== before.latestDiscard?.id ? state.latestDiscard : null;
    const opponentDiscard = newDiscard?.playerId !== state.you.id ? newDiscard : null;
    if (opponentDiscard) animateTransfer(opponentDiscard.cards, false, "discard", playerStacks.current.get(opponentDiscard.playerId) ?? null, discardRef.current);
    const actorId = before.currentPlayerId;
    if (!actorId || actorId === state.you.id || before.turnPhase !== "draw") return;
    const deckDrawn = state.drawPileCount < before.drawPileCount;
    const exposedBefore = before.drawSourceDiscard?.cards ?? [];
    const exposedNow = new Set((state.drawSourceDiscard?.cards ?? []).map((card) => card.id));
    const exposedCard = exposedBefore.find((card) => !exposedNow.has(card.id));
    if (deckDrawn) animateTransfer([undefined], true, "draw", deckRef.current, playerStacks.current.get(actorId) ?? null, opponentDiscard ? 360 : 0);
    else if (exposedCard) animateTransfer([exposedCard], false, "draw", discardRef.current, playerStacks.current.get(actorId) ?? null, opponentDiscard ? 360 : 0);
  }, [animateTransfer, state]);
  const sort = (kind: "rank" | "suit" | "value") => setOrder([...hand].sort((a, b) => kind === "rank" ? rankIndex(a.rank) - rankIndex(b.rank) : kind === "suit" ? suitOrder[a.suit] - suitOrder[b.suit] || rankIndex(a.rank) - rankIndex(b.rank) : getCardValue(a.rank) - getCardValue(b.rank)).map((card) => card.id));
  const move = (direction: -1 | 1) => { if (activeSelected.length !== 1) return; const index = hand.findIndex((card) => card.id === activeSelected[0]); const target = index + direction; if (target < 0 || target >= hand.length) return; const next = [...hand]; [next[index], next[target]] = [next[target], next[index]]; setOrder(next.map((card) => card.id)); };
  const startHandDrag = (event: React.PointerEvent<HTMLButtonElement>, cardId: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    handDrag.current = { cardId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const updateHandDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = handDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
    if (!drag.dragging) { drag.dragging = true; suppressCardClick.current = true; setDraggingCardId(drag.cardId); }
    event.preventDefault();
    const area = handAreaRef.current;
    if (area) {
      const bounds = area.getBoundingClientRect();
      if (event.clientX < bounds.left + 34) area.scrollLeft -= 12;
      else if (event.clientX > bounds.right - 34) area.scrollLeft += 12;
    }
    const candidates = hand.filter((card) => card.id !== drag.cardId).map((card) => ({ id: card.id, center: (handCards.current.get(card.id)?.getBoundingClientRect().left ?? 0) + (handCards.current.get(card.id)?.getBoundingClientRect().width ?? 0) / 2 })).sort((left, right) => left.center - right.center);
    const before = candidates.find((candidate) => event.clientX < candidate.center);
    setDragTargetId(before?.id ?? candidates.at(-1)?.id ?? null);
    const currentIds = hand.map((card) => card.id);
    const withoutDragged = currentIds.filter((id) => id !== drag.cardId);
    const insertionIndex = before ? withoutDragged.indexOf(before.id) : withoutDragged.length;
    withoutDragged.splice(Math.max(0, insertionIndex), 0, drag.cardId);
    if (withoutDragged.some((id, index) => id !== currentIds[index])) setOrder(withoutDragged);
  };
  const finishHandDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = handDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    handDrag.current = null;
    if (drag.dragging) {
      const position = hand.findIndex((card) => card.id === drag.cardId) + 1;
      setReorderAnnouncement(`Card moved to position ${Math.max(1, position)} of ${hand.length}.`);
      window.setTimeout(() => { suppressCardClick.current = false; }, 0);
    }
    setDraggingCardId(null); setDragTargetId(null);
  };
  const activePlayerName = state.players.find((player) => player.id === state.currentPlayerId)?.name ?? "Table";
  const showDeclarerName = state.players.find((player) => player.id === state.showState.declarerId)?.name ?? "A player";
  return <YunufShell className={`flex h-dvh min-h-dvh flex-col overflow-hidden transition-colors duration-500 ${yourTurn ? "yunuf-your-turn" : "yunuf-waiting-turn"}`}><header className="relative z-10 border-b border-white/[.06] bg-black/15 px-4 pb-3 pt-3"><div className="grid grid-cols-[88px_1fr_88px] items-center"><button aria-label="Leave match" onClick={() => { if (window.confirm("Leave this Yunuf match? You can rejoin with the same link.")) leave(); }} className="yunuf-icon-button"><LogOut size={14}/></button><div className="text-center"><div className="yunuf-eyebrow">Hand {state.handNumber}</div><div className="mt-0.5 text-[9px] text-white/35">{state.completedRounds}/3 rounds before Show</div></div><div className="flex justify-end gap-1"><button aria-label="Open game log" onClick={() => void openLog()} className="yunuf-icon-button"><ScrollText size={14}/></button><button aria-label={muted ? "Turn sound on" : "Mute sound"} onClick={() => setMuted(!muted)} className="yunuf-icon-button">{muted ? <VolumeX size={14}/> : <Volume2 size={14}/>}</button></div></div></header>
    {state.showState.active && <><div className="show-pulse relative z-10 border-b border-[#d7b45a]/35 bg-[#d7b45a]/15 px-4 py-3 text-center"><div className="flex items-center justify-center gap-2 text-[11px] font-black text-[#f4d982]"><Eye size={14}/>{showDeclarerName.toUpperCase()} CALLED SHOW</div><div className="mt-1 text-[9px] font-bold text-white/60">Final turns are live · the hand ends after {state.players.find((player) => player.id === state.showState.resolveAfterPlayerId)?.name}</div></div><div key={state.showState.declarerId} className="yunuf-show-announcement pointer-events-none absolute inset-0 z-[70] grid place-items-center bg-[#080b09]/90 p-6 text-center"><div><div className="mx-auto grid size-24 place-items-center rounded-full border border-[#e8cf8a]/50 bg-[#d7b45a]/15 shadow-[0_0_80px_rgba(215,180,90,.35)]"><Eye size={38} className="text-[#f4d982]"/></div><div className="mt-6 text-[11px] font-black tracking-[.22em] text-[#e8cf8a]">{showDeclarerName.toUpperCase()} CALLED</div><div className="mt-2 text-5xl font-black tracking-[-.06em] text-[#f8f1dc]">SHOW!</div><div className="mt-4 text-[11px] font-bold text-white/55">Everyone else gets one final turn.</div></div></div></>}
    <div className={`min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3 ${yourTurn ? "" : "yunuf-waiting-board"}`}><PlayerRail state={state} registerStack={(playerId, element) => { if (element) playerStacks.current.set(playerId, element); else playerStacks.current.delete(playerId); }}/><div className={`mt-3 flex items-center justify-between rounded-xl border px-3 py-2.5 transition ${yourTurn ? "border-[#d7b45a]/55 bg-[#d7b45a]/15 shadow-[0_0_28px_rgba(215,180,90,.12)]" : "border-white/[.06] bg-black/20"}`}><span className={`flex items-center gap-1.5 text-[10px] font-black ${yourTurn ? "text-[#f4d982]" : "text-white/45"}`}>{yourTurn && <Sparkles size={12}/>} {yourTurn ? "YOUR TURN · PLAY NOW" : `${activePlayerName.toUpperCase()} IS PLAYING`}</span><TurnClock startedAt={state.turnStartedAt} seconds={showDecisionActive ? SHOW_DECISION_SECONDS : state.turnDurationSeconds}/></div>
      <div className="mt-4 grid grid-cols-2 gap-5 px-5"><button ref={deckRef} aria-label="Draw from face-down deck" disabled={!yourTurn || state.turnPhase !== "draw" || loading} onClick={async () => { animateTransfer([undefined], true, "draw", deckRef.current, handAreaRef.current, 0, true); beginIncomingDraw(undefined, true); await mutate({ action: "draw_deck" }); finishIncomingDraw(); }} className="group rounded-xl py-2 text-center transition disabled:opacity-45 enabled:bg-[#d7b45a]/[.055] enabled:ring-1 enabled:ring-[#d7b45a]/25 enabled:active:scale-[.98]"><div className="card-back mx-auto grid h-[96px] w-[68px] place-items-center rounded-lg border-2 border-[#d7b45a]/25"><Layers3 size={20} className="text-[#d7b45a]"/></div><div className="mt-2 text-[9px] font-black text-white/45">FACE-DOWN · {visibleDrawPileCount}</div></button><button ref={discardRef} aria-label={topDiscardCard ? `Draw top discard: ${topDiscardCard.rank} of ${topDiscardCard.suit}` : "Top discard"} disabled={!yourTurn || state.turnPhase !== "draw" || loading || !topDiscardCard} onClick={async (event) => { if (!topDiscardCard) return; animateTransfer([topDiscardCard], false, "draw", event.currentTarget, handAreaRef.current, 0, true); beginIncomingDraw(topDiscardCard, false); await mutate({ action: "draw_discard", cardId: topDiscardCard.id }); finishIncomingDraw(); }} className="group rounded-xl py-2 text-center transition disabled:opacity-55 enabled:bg-[#d7b45a]/[.055] enabled:ring-1 enabled:ring-[#d7b45a]/25 enabled:active:scale-[.98]"><div className="discard-top-card relative mx-auto h-[96px] w-[68px]">{displayedDiscardCard && <PlayingCard card={displayedDiscardCard} small/>}</div><div className="mt-2 text-[9px] font-black text-white/45">{yourTurn && state.turnPhase === "draw" ? "TAKE TOP CARD" : "TOP DISCARD"}</div></button></div>
      {yourTurn && state.turnPhase === "draw" && <div className="mt-3 text-center"><div className="text-[9px] font-black text-[#e8cf8a]">DRAW ONE CARD</div><p className="mt-1 text-[8px] text-white/35">Choose the face-down deck or the top discard.</p></div>}
      {error && <div className="yunuf-keep-visible"><YunufError message={error}/></div>}<div className="yunuf-hand-heading mt-4 text-center"><div className="text-[10px] font-black text-[#e8cf8a]">Your hand · {visibleHandValue} points</div><div className="mt-1 text-[8px] text-white/30">{yourTurn ? state.turnPhase === "discard" ? "Select cards to discard · drag to arrange" : state.turnPhase === "draw" ? "Now draw exactly one" : "Five seconds: call Show or pass" : "Drag your cards to plan the next move"}</div></div>
      <div ref={handAreaRef} className="yunuf-local-hand mt-3 flex min-h-[130px] items-end overflow-x-auto px-2 pb-2 pt-5">{hand.map((card, index) => { const selectionIndex = activeSelected.indexOf(card.id); const selectedNow = selectionIndex >= 0; const isTop = selectedNow && selectionIndex === activeSelected.length - 1; const canSelect = yourTurn && state.turnPhase === "discard"; return <button data-hand-card={card.id} ref={(element) => { if (element) handCards.current.set(card.id, element); else handCards.current.delete(card.id); }} key={card.id} aria-label={`${card.rank} of ${card.suit}`} aria-pressed={selectedNow} aria-disabled={!canSelect} onPointerDown={(event) => startHandDrag(event, card.id)} onPointerMove={updateHandDrag} onPointerUp={finishHandDrag} onPointerCancel={finishHandDrag} onDragStart={(event) => event.preventDefault()} onClick={() => { if (suppressCardClick.current || !canSelect) return; setSelected((ids) => ids.includes(card.id) ? ids.filter((id) => id !== card.id) : [...ids, card.id]); }} className={`relative shrink-0 touch-none select-none transition-[transform,filter] ${index ? "-ml-4" : ""} ${departing.includes(card.id) ? "invisible" : ""} ${draggingCardId === card.id ? "z-40 -translate-y-6 rotate-2 scale-105 brightness-110 drop-shadow-[0_16px_18px_rgba(0,0,0,.55)]" : selectedNow ? "z-20 -translate-y-4" : "hover:-translate-y-1"} ${draggingCardId && dragTargetId === card.id && draggingCardId !== card.id ? "drop-shadow-[0_0_10px_rgba(215,180,90,.8)]" : ""}`}><PlayingCard card={card} selected={selectedNow}/>{selectedNow && <span className={`absolute -right-1 -top-2 z-30 grid min-w-5 place-items-center rounded-full border px-1 py-1 text-[7px] font-black shadow-lg ${isTop ? "border-[#f8f1dc]/35 bg-[#d7b45a] text-[#17201d]" : "border-white/20 bg-[#17201d] text-[#e8cf8a]"}`}>{isTop ? "TOP" : selectionIndex + 1}</span>}</button>; })}{incomingDraw?.landed && <span className={`${hand.length ? "-ml-4" : ""} yunuf-incoming-hand-card relative z-30 shrink-0`}>{incomingDraw.faceDown || !incomingDraw.card ? <span className="card-back block h-[112px] w-[76px] rounded-lg border-2 border-[#d7b45a]/35"/> : <PlayingCard card={incomingDraw.card}/>}</span>}</div><span className="sr-only" aria-live="polite">{reorderAnnouncement}</span>
      <div className="flex items-center justify-center gap-1.5"><span className="mr-1 text-[8px] font-bold text-white/25">SORT</span>{(["rank","suit","value"] as const).map((kind) => <button key={kind} onClick={() => sort(kind)} className="min-h-8 rounded-md border border-white/[.07] px-2 text-[8px] font-bold uppercase text-white/40">{kind}</button>)}<button aria-label="Move selected card left" disabled={activeSelected.length !== 1} onClick={() => move(-1)} className="yunuf-mini-button"><ChevronLeft size={12}/></button><button aria-label="Move selected card right" disabled={activeSelected.length !== 1} onClick={() => move(1)} className="yunuf-mini-button"><ChevronRight size={12}/></button></div>
    </div>
    <div className="border-t border-white/[.07] bg-[#121a18]/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">{yourTurn && state.turnPhase === "discard" && <><div className={`mb-2 text-center text-[9px] font-bold ${activeSelected.length && validation.valid ? "text-emerald-200" : "text-white/35"}`}>{!activeSelected.length ? "Select in landing order · your last pick stays on top" : validation.valid ? `Valid ${validation.playType} · ${topSelectedCard?.rank} will stay on top` : validation.error}</div><YunufButton disabled={loading || !validation.valid} onClick={async () => { const cardIds = [...activeSelected]; animateTransfer(selectedCards, false, "discard", selectedCards.map((card) => handCards.current.get(card.id) ?? null), discardRef.current, 0, true); setDeparting(cardIds); const result = await mutate({ action: "discard", cardIds }); setDeparting([]); if (result) setSelected([]); }}><ArrowDownToLine size={15}/>Discard {activeSelected.length || "cards"}{topSelectedCard ? ` · ${topSelectedCard.rank} on top` : ""}</YunufButton></>}
      {yourTurn && state.turnPhase === "draw" && <div className="text-center text-[10px] font-bold text-[#e8cf8a]">Choose one of the two piles above</div>}
      {canChooseShow && <ShowDecisionControls deadline={(state.turnStartedAt ?? 0) + SHOW_DECISION_SECONDS * 1000} loading={loading} onDecision={submitDecision}/>}
      {!yourTurn && <div className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/[.06] bg-black/25 text-[11px] font-black text-white/55"><Clock3 size={14}/>Waiting for {activePlayerName}</div>}</div>
    <CardMotionLayer motions={motions} onDone={(id) => setMotions((current) => current.filter((motion) => motion.id !== id))}/>
    {showLog && <YunufGameLog state={state} events={logEvents} loading={logLoading} error={logError} onClose={() => setShowLog(false)}/>}
  </YunufShell>;
}

function ShowDecisionControls({ deadline, loading, onDecision }: { deadline: number; loading: boolean; onDecision: (action: "end_turn" | "declare_show") => Promise<void> }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(ticker);
  }, [deadline]);
  useEffect(() => {
    const timer = window.setTimeout(() => void onDecision("end_turn"), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline, onDecision]);
  const totalMs = SHOW_DECISION_SECONDS * 1000;
  const remainingMs = now === null ? totalMs : Math.max(0, deadline - now);
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const progress = Math.min(100, Math.max(0, 100 * (1 - remainingMs / totalMs)));
  return <div className="grid grid-cols-2 gap-2"><YunufButton secondary disabled={loading} onClick={() => void onDecision("end_turn")}>Pass turn<ArrowRight size={14}/></YunufButton><button aria-label={`Declare Show, ${secondsLeft} seconds left`} disabled={loading} onClick={() => void onDecision("declare_show")} className="relative flex min-h-12 w-full items-center justify-center overflow-hidden rounded-xl border border-[#d7b45a]/60 bg-[#1a211d] px-3 text-[11px] font-black text-[#f8f1dc] shadow-[0_0_25px_rgba(215,180,90,.16)] transition active:scale-[.985] disabled:opacity-40"><span aria-hidden className="absolute inset-y-0 left-0 bg-[#d7b45a] transition-[width] duration-75 ease-linear" style={{ width: `${progress}%` }}/><span className={`relative z-10 flex items-center gap-2 ${progress > 52 ? "text-[#17201d]" : "text-[#f4d982]"}`}><Eye size={14}/>SHOW · {secondsLeft}</span></button></div>;
}

function PlayerRail({ state, registerStack }: { state: YunufViewState; registerStack: (playerId: string, element: HTMLDivElement | null) => void }) {
  const waitingOnOpponent = state.currentPlayerId !== state.you.id;
  return <div className="yunuf-player-rail flex gap-2 overflow-x-auto px-1 pb-2 pt-1">{state.players.map((player) => {
    const active = player.id === state.currentPlayerId;
    const activeOpponent = active && player.id !== state.you.id;
    return <div data-player-card={player.id} key={player.id} className={`relative min-w-[116px] rounded-xl border p-2.5 transition-all duration-300 ${activeOpponent ? "z-10 scale-[1.035] border-[#e8cf8a]/75 bg-[#d7b45a]/20 shadow-[0_0_28px_rgba(215,180,90,.28)]" : active ? "border-[#d7b45a]/45 bg-[#d7b45a]/10" : waitingOnOpponent ? "border-white/[.04] bg-black/15 opacity-45" : "border-white/[.06] bg-white/[.025]"}`}>{activeOpponent && <span className="absolute -right-1.5 -top-2 rounded-full border border-[#f4d982]/40 bg-[#d7b45a] px-2 py-1 text-[7px] font-black tracking-wider text-[#17201d] shadow-lg">PLAYING</span>}<div className="flex items-center gap-2"><Avatar index={player.avatar} size="sm"/><div className="min-w-0 flex-1"><div className={`truncate text-[9px] font-black ${activeOpponent ? "text-[#f8e8af]" : ""}`}>{player.id === state.you.id ? "You" : player.name}</div><div className="mt-0.5 flex items-center justify-between text-[7px] text-white/30"><span>Score</span><b className={player.totalScore >= state.eliminationScore * .75 ? "text-red-300" : "text-[#e8cf8a]"}>{player.totalScore}</b></div></div></div><PhysicalHand ref={(element) => registerStack(player.id, element)} count={player.cardCount} active={active}/></div>;
  })}</div>;
}

function PhysicalHand({ count, active, ref }: { count: number; active: boolean; ref: React.Ref<HTMLDivElement> }) {
  const visibleCards = Math.min(count, 9); const width = visibleCards ? 20 + (visibleCards - 1) * 7 : 20;
  return <div ref={ref} aria-label={`${count} cards in hand`} className={`relative mx-auto mt-2 h-8 transition-transform ${active ? "yunuf-hand-active" : ""}`} style={{ width }}>{Array.from({ length: visibleCards }, (_, index) => <span key={index} className="yunuf-player-card-back absolute bottom-0" style={{ left: index * 7, transform: `rotate(${(index - (visibleCards - 1) / 2) * 2.2}deg)` }}/>)}</div>;
}

function CardMotionLayer({ motions, onDone }: { motions: CardMotion[]; onDone: (id: string) => void }) {
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">{motions.map((motion) => {
    const style = {
      "--from-x": `${motion.from.x}px`, "--from-y": `${motion.from.y}px`, "--via-x": `${motion.via.x}px`, "--via-y": `${motion.via.y}px`, "--to-x": `${motion.to.x}px`, "--to-y": `${motion.to.y}px`, "--motion-rotation": `${motion.rotation}deg`, animationDelay: `${motion.delay}ms`,
    } as React.CSSProperties;
    return <div key={motion.id} className={`yunuf-card-motion ${motion.large ? "yunuf-card-motion-large" : ""} yunuf-card-motion-${motion.kind}`} style={style} onAnimationEnd={() => onDone(motion.id)}>{motion.faceDown || !motion.card ? <span className="card-back yunuf-motion-card-back"/> : <PlayingCard card={motion.card} small={motion.large} tiny={!motion.large}/>}</div>;
  })}</div>;
}

function GameLogLauncher({ state, loadLog }: { state: YunufViewState; loadLog: () => Promise<YunufGameEvent[]> }) {
  const [open, setOpen] = useState(false); const [events, setEvents] = useState<YunufGameEvent[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const show = async () => { setOpen(true); setLoading(true); setError(null); try { setEvents(await loadLog()); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the game history."); } finally { setLoading(false); } };
  return <><button aria-label="Open game log" onClick={() => void show()} className="yunuf-icon-button absolute right-5 top-7 z-20"><ScrollText size={14}/></button>{open && <YunufGameLog state={state} events={events} loading={loading} error={error} onClose={() => setOpen(false)}/>}</>;
}

function YunufGameLog({ state, events: chronologicalEvents, loading, error, onClose }: { state: YunufViewState; events: YunufGameEvent[]; loading: boolean; error: string | null; onClose: () => void }) {
  const events: YunufGameEvent[] = loading || error ? [{ id: "history-status", type: "draw_deck", playerId: null, handNumber: state.handNumber, turnNumber: state.turnNumber, createdAt: 0 }] : [...chronologicalEvents].reverse(); const playerName = (id: string | null) => state.players.find((player) => player.id === id)?.name ?? "Table"; const cards = (items = [] as Card[]) => items.map((card) => `${card.rank}${suitSymbol[card.suit]}`).join(" → ");
  const describe = (event: (typeof events)[number]) => {
    const name = playerName(event.playerId);
    if (event.id === "history-status") return error ?? "Loading the server record…";
    switch (event.type) {
      case "match_started": return `${name} started the match · ${cards(event.cards)} opened the pile`;
      case "hand_started": return `${name} dealt Hand ${event.handNumber} · ${cards(event.cards)} opened the pile`;
      case "discard": return `${name} discarded ${cards(event.cards)} · ${event.cards?.at(-1)?.rank ?? "card"} on top`;
      case "draw_deck": return `${name} drew one face-down card`;
      case "draw_discard": return `${name} took ${cards(event.cards)} from the top discard`;
      case "turn_ended": return `${name} completed their turn`;
      case "show_declared": return `${name} declared Show`;
      case "turn_timed_out": return `${name} timed out · server auto-played${event.cards?.length ? ` ${cards(event.cards)}` : " the turn"}`;
      case "match_reset": return `${name} reset the table for another match`;
      case "hand_resolved": {
        const winners = event.winnerIds?.map(playerName).join(" & ") || "No winner";
        const values = Object.entries(event.handValues ?? {}).map(([id, value]) => `${playerName(id)} ${value}`).join(" · ");
        return `Hand ${event.handNumber} scored · ${winners} won${values ? ` · ${values}` : ""}`;
      }
    }
  };
  return <div role="dialog" aria-modal="true" aria-labelledby="yunuf-log-title" className="absolute inset-0 z-[80] flex flex-col bg-[#101714]/98 backdrop-blur-xl"><header className="flex items-center justify-between border-b border-white/[.07] px-5 py-4"><div><div className="yunuf-eyebrow">Server record</div><h2 id="yunuf-log-title" className="mt-1 text-lg font-black">Game history</h2></div><button aria-label="Close game log" onClick={onClose} className="yunuf-icon-button"><X size={16}/></button></header><div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{events.length ? <ol className="space-y-2">{events.map((event) => <li key={event.id} className="rounded-xl border border-white/[.07] bg-white/[.025] p-3"><div className="flex items-center justify-between gap-3"><span className="text-[8px] font-black uppercase tracking-wider text-[#e8cf8a]">Hand {event.handNumber} · Turn {event.turnNumber}</span><time className="text-[8px] text-white/25">{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p className="mt-1.5 text-[10px] leading-4 text-white/65">{describe(event)}</p>{event.roundScores && <div className="mt-2 text-[8px] text-white/30">Round scores · {Object.entries(event.roundScores).map(([id, value]) => `${playerName(id)} +${value}`).join(" · ")}</div>}</li>)}</ol> : <div className="grid min-h-52 place-items-center text-center"><div><ScrollText className="mx-auto text-white/20" size={28}/><p className="mt-3 text-[10px] text-white/35">The first move will appear here.</p></div></div>}</div><footer className="border-t border-white/[.07] px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 text-center text-[8px] leading-4 text-white/25">Persistent server-authored record · deck-card identities remain private</footer></div>;
}

function TurnClock({ startedAt, seconds }: { startedAt: number | null; seconds: number }) { const [now, setNow] = useState<number | null>(null); useEffect(() => { const tick = () => setNow(Date.now()); const timer = window.setInterval(tick, 500); return () => window.clearInterval(timer); }, []); const left = startedAt && now ? Math.max(0, Math.ceil((startedAt + seconds * 1000 - now) / 1000)) : seconds; return <span className={`inline-flex items-center gap-1 text-[10px] font-black ${left <= 8 ? "text-red-300" : "text-[#e8cf8a]"}`}><Clock3 size={11}/>{left}s</span>; }

function YunufResults({ state, loading, mutate, leave }: GameProps) { const result = state.result!; return <YunufShell className="px-5 pb-8 pt-7"><div className="flex justify-between"><button onClick={leave} className="yunuf-icon-button"><House size={15}/></button><YunufMark/><span className="size-11"/></div><div className="mt-7 text-center"><div className="yunuf-eyebrow">Hand {state.handNumber} revealed</div><Trophy className="mx-auto mt-5 text-[#e8cf8a]" size={34}/><h1 className="mt-3 text-[27px] font-black">{result.winnerIds.length > 1 ? "Joint winners!" : `${state.players.find((player) => player.id === result.winnerIds[0])?.name} wins the hand`}</h1><p className="mt-2 text-[10px] text-white/40">{state.players.find((player) => player.id === result.declarerId)?.name} declared Show.</p></div><div className="mt-7 space-y-3">{[...state.players].sort((a,b) => (result.handValues[a.id] ?? 99)-(result.handValues[b.id] ?? 99)).map((player) => <div key={player.id} className={`rounded-xl border p-3 ${result.winnerIds.includes(player.id) ? "border-[#d7b45a]/35 bg-[#d7b45a]/10" : "border-white/[.07] bg-white/[.025]"}`}><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Avatar index={player.avatar} size="sm"/><div><div className="text-[10px] font-black">{player.name}{player.id === result.declarerId ? " · SHOW" : ""}</div><div className="mt-0.5 text-[8px] text-white/35">+{result.roundScores[player.id]} this hand · {player.totalScore} total</div></div></div><div className="text-xl font-black text-[#e8cf8a]">{result.handValues[player.id]}</div></div><div className="mt-3 flex gap-1 overflow-x-auto">{player.hand?.map((card) => <PlayingCard key={card.id} card={card} tiny reveal/>)}</div>{result.eliminatedIds.includes(player.id) && <div className="mt-2 text-[8px] font-black text-red-300">ELIMINATED AT {player.totalScore}</div>}{player.id === result.declarerId && !result.declarerWon && <div className="mt-2 text-[8px] font-black text-red-300">+10 FAILED SHOW PENALTY</div>}</div>)}</div>{state.you.id === state.hostPlayerId ? <YunufButton className="mt-6" disabled={loading} onClick={() => mutate({ action: "continue" })}><RotateCcw size={14}/>Deal next hand</YunufButton> : <p className="mt-6 text-center text-[10px] text-white/35">Waiting for the host to deal…</p>}</YunufShell>; }

function YunufMatchOver({ state, loading, mutate, leave }: GameProps) { const winners = state.result?.matchWinnerIds ?? []; return <YunufShell className="flex flex-col px-6 pb-8 pt-8"><button onClick={leave} className="yunuf-icon-button"><House size={15}/></button><div className="flex flex-1 flex-col justify-center text-center"><div className="relative mx-auto grid size-28 place-items-center rounded-full border border-[#d7b45a]/35 bg-[#d7b45a]/10 shadow-[0_0_70px_rgba(215,180,90,.25)]"><Crown size={42} className="text-[#e8cf8a]"/><Sparkles className="absolute -right-1 top-1 text-[#e8cf8a]"/></div><div className="yunuf-eyebrow mt-8">Match complete</div><h1 className="mt-3 text-[34px] font-black">{winners.length > 1 ? "Joint champions" : `${state.players.find((player) => player.id === winners[0])?.name} wins Yunuf`}</h1><div className="mt-6 space-y-2">{[...state.players].sort((a,b) => a.totalScore-b.totalScore).map((player) => <div key={player.id} className="rounded-xl border border-white/[.07] bg-white/[.025] px-4 py-3"><div className="flex items-center justify-between"><span className="text-[11px] font-black">{player.name}</span><span className="text-[11px] font-black text-[#e8cf8a]">{player.totalScore} pts</span></div><div className="mt-1 text-left text-[8px] text-white/30">{player.handsWon} wins · {player.showsDeclared} Shows · {player.failedShows} failed</div></div>)}</div></div><div className="grid grid-cols-2 gap-2">{state.you.id === state.hostPlayerId ? <YunufButton onClick={() => mutate({ action: "reset" })} disabled={loading}><RotateCcw size={14}/>Play again</YunufButton> : <div className="grid place-items-center text-[9px] text-white/35">Host can restart</div>}<YunufButton secondary onClick={leave} disabled={loading}>Leave room</YunufButton></div></YunufShell>; }

function PlayingCard({ card, selected, small, tiny, decorative, reveal, className = "", style }: { card: Card; selected?: boolean; small?: boolean; tiny?: boolean; decorative?: boolean; reveal?: boolean; className?: string; style?: React.CSSProperties }) { const red = card.suit === "hearts" || card.suit === "diamonds"; const dimensions = tiny ? "h-[62px] w-[43px] rounded-md" : small ? "h-[96px] w-[68px] rounded-lg" : "h-[112px] w-[76px] rounded-lg"; return <span aria-hidden={decorative || undefined} style={style} className={`${reveal ? "card-reveal" : ""} ${dimensions} ${selected ? "ring-2 ring-[#d7b45a] shadow-[0_0_22px_rgba(215,180,90,.3)]" : ""} ${className} relative block border border-black/15 bg-[#faf4df] p-1.5 text-left shadow-[0_7px_16px_rgba(0,0,0,.32)] ${red ? "text-[#a52a31]" : "text-[#151b19]"}`}><b className={`${tiny ? "text-[12px]" : "text-[17px]"} block leading-none`}>{card.rank}</b><span className={`${tiny ? "text-[11px]" : "text-[16px]"} leading-none`}>{suitSymbol[card.suit]}</span><span className={`${tiny ? "text-[18px]" : "text-[28px]"} absolute inset-0 grid place-items-center opacity-90`}>{suitSymbol[card.suit]}</span></span>; }
function YunufButton({ children, secondary, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) { return <button className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border px-4 text-[11px] font-black transition active:scale-[.985] disabled:opacity-35 ${secondary ? "border-[#d7b45a]/40 bg-transparent text-[#e8cf8a]" : "border-transparent bg-[#d7b45a] text-[#17201d] shadow-[0_8px_25px_rgba(215,180,90,.16)]"} ${className}`} {...props}>{children}</button>; }
function YunufError({ message }: { message: string }) { return <div role="alert" className="mt-4 rounded-lg border border-red-300/20 bg-red-400/10 px-3 py-2 text-center text-[10px] font-bold text-red-200">{message}</div>; }
