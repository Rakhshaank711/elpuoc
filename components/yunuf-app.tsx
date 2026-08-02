"use client";

import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Clock3, Copy,
  Crown, Eye, House, Layers3, LogOut, Play, RotateCcw, Send, ShieldAlert, Sparkles,
  Trophy, Users, Volume2, VolumeX,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Field } from "./ui";
import { getBrowserClient } from "@/lib/supabase/browser";
import { calculateHandValue, eligibleDiscardDrawIds, getCardValue, rankIndex, validateDiscard } from "@/lib/yunuf/rules";
import type { Card, Suit, YunufSession, YunufViewState } from "@/lib/yunuf/types";

type Entry = "landing" | "create" | "join";
type MotionPoint = { x: number; y: number };
type CardMotion = { id: string; card?: Card; faceDown: boolean; kind: "discard" | "draw"; from: MotionPoint; via: MotionPoint; to: MotionPoint; delay: number; rotation: number };
const sessionKey = (code: string) => `yunuf:${code.toUpperCase()}`;
const suitSymbol: Record<Suit, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
const suitOrder: Record<Suit, number> = { hearts: 0, diamonds: 1, clubs: 2, spades: 3 };
const motionPoint = (element: HTMLElement | null): MotionPoint | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - 21.5, y: rect.top + rect.height / 2 - 31 };
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
  const [connectedIds, setConnectedIds] = useState(new Set<string>());
  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getBrowserClient>>["channel"]> | null>(null);

  const fetchState = useCallback(async (active: YunufSession, quiet = false) => {
    try {
      const result = await api<{ state: YunufViewState }>(`/api/yunuf?code=${active.code}&playerId=${active.playerId}`, { headers: { "x-player-token": active.token }, cache: "no-store" });
      setState(result.state);
      if (!quiet) setError(null);
    } catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : "Could not load Yunuf."); }
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("room")?.toUpperCase();
    if (!code) { queueMicrotask(() => setBooting(false)); return; }
    const stored = localStorage.getItem(sessionKey(code));
    if (!stored) { queueMicrotask(() => { setEntry("join"); setBooting(false); }); return; }
    try {
      const active = JSON.parse(stored) as YunufSession;
      queueMicrotask(() => { setSession(active); void fetchState(active).finally(() => setBooting(false)); });
    } catch { localStorage.removeItem(sessionKey(code)); queueMicrotask(() => setBooting(false)); }
  }, [fetchState]);

  useEffect(() => {
    if (!session || !state?.roomId) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(`yunuf:${state.roomId}`, { config: { presence: { key: session.playerId }, broadcast: { self: false } } });
    channelRef.current = channel;
    channel.on("broadcast", { event: "state_changed" }, ({ payload }) => { if (payload?.actorId !== session.playerId) void fetchState(session, true); })
      .on("presence", { event: "sync" }, () => {
        const presence = channel.presenceState<{ playerId: string }>();
        setConnectedIds(new Set(Object.values(presence).flat().map((item) => item.playerId)));
      })
      .subscribe(async (status) => { if (status === "SUBSCRIBED") await channel.track({ playerId: session.playerId, name: session.name, role: session.role, joinedAt: new Date().toISOString() }); });
    const interval = window.setInterval(() => void fetchState(session, true), 4_000);
    const focus = () => { if (!document.hidden) void fetchState(session, true); };
    document.addEventListener("visibilitychange", focus);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", focus); channelRef.current = null; void supabase.removeChannel(channel); };
  }, [fetchState, session, state?.roomId]);

  const enter = async (payload: Record<string, unknown>) => {
    setLoading(true); setError(null);
    try {
      const result = await api<{ session: YunufSession }>("/api/yunuf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      localStorage.setItem(sessionKey(result.session.code), JSON.stringify(result.session));
      setSession(result.session);
      router.replace(`/games/yunuf?room=${result.session.code}`);
      await fetchState(result.session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not enter the room."); }
    finally { setLoading(false); }
  };

  const mutate = async (payload: Record<string, unknown>) => {
    if (!session || !state) return;
    setLoading(true); setError(null);
    try {
      const needsVersion = payload.action !== "ready";
      const result = await api<{ state: YunufViewState }>("/api/yunuf", { method: "POST", headers: { "content-type": "application/json", "x-player-id": session.playerId, "x-player-token": session.token }, body: JSON.stringify({ ...payload, code: session.code, ...(needsVersion ? { expectedVersion: state.version, actionId: crypto.randomUUID() } : {}) }) });
      setState(result.state);
      return result.state;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That move did not work.");
      if (cause instanceof ApiError && cause.status === 409) await fetchState(session, true);
    } finally { setLoading(false); }
  };

  const leave = () => { setSession(null); setState(null); setError(null); router.push("/"); };
  if (booting) return <YunufShell><div className="grid min-h-dvh place-items-center"><YunufMark/></div></YunufShell>;
  if (!session || !state) {
    if (entry === "landing") return <YunufLanding onHome={() => router.push("/")} onCreate={() => setEntry("create")} onJoin={() => setEntry("join")}/>;
    return <YunufEntry mode={entry} loading={loading} error={error} onBack={() => setEntry("landing")} onSubmit={enter}/>;
  }
  const connectedState = { ...state, players: state.players.map((player) => ({ ...player, connected: connectedIds.has(player.id) || player.id === session.playerId })) };
  if (state.status === "lobby") return <YunufLobby state={connectedState} loading={loading} error={error} mutate={mutate} leave={leave}/>;
  if (state.status === "hand_results") return <YunufResults state={connectedState} loading={loading} mutate={mutate} leave={leave}/>;
  if (state.status === "match_over") return <YunufMatchOver state={connectedState} loading={loading} mutate={mutate} leave={leave}/>;
  return <YunufTable state={connectedState} loading={loading} error={error} mutate={mutate} leave={leave}/>;
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

type GameProps = { state: YunufViewState; loading: boolean; mutate: (payload: Record<string, unknown>) => Promise<YunufViewState | undefined>; leave: () => void; error?: string | null };

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

function YunufTable({ state, loading, mutate, leave, error }: GameProps) {
  const you = state.players.find((player) => player.id === state.you.id)!; const yourTurn = state.currentPlayerId === you.id; const [selected, setSelected] = useState<string[]>([]); const [showConfirm, setShowConfirm] = useState(false); const [muted, setMuted] = useState(true); const [order, setOrder] = useState(() => (you.hand ?? []).map((card) => card.id));
  const [motions, setMotions] = useState<CardMotion[]>([]); const motionSequence = useRef(0); const previousState = useRef<YunufViewState | null>(null); const playerStacks = useRef(new Map<string, HTMLDivElement>()); const deckRef = useRef<HTMLButtonElement>(null); const discardRef = useRef<HTMLDivElement>(null);
  const hand = useMemo(() => [...(you.hand ?? [])].sort((left, right) => {
    const leftIndex = order.indexOf(left.id); const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }), [order, you.hand]);
  const activeSelected = selected.filter((id) => hand.some((card) => card.id === id));
  const selectedCards = activeSelected.map((id) => hand.find((card) => card.id === id)!).filter(Boolean) as Card[];
  const validation = validateDiscard(selectedCards); const sourceIds = state.drawSourceDiscard ? eligibleDiscardDrawIds(state.drawSourceDiscard.cards, state.drawSourceDiscard.playType) : [];
  const animateTransfer = useCallback((cards: Array<Card | undefined>, faceDown: boolean, kind: CardMotion["kind"], fromElement: HTMLElement | null, toElement: HTMLElement | null, extraDelay = 0) => {
    const from = motionPoint(fromElement); const to = motionPoint(toElement);
    if (!from || !to) return;
    const next = cards.map((card, index) => {
      const spread = (index - (cards.length - 1) / 2) * 7;
      const id = `motion-${++motionSequence.current}`;
      return { id, card, faceDown, kind, from: { x: from.x + spread, y: from.y }, via: { x: (from.x + to.x) / 2 + spread, y: (from.y + to.y) / 2 - (kind === "discard" ? 64 : 50) }, to: { x: to.x + spread, y: to.y }, delay: extraDelay + index * 80, rotation: (index - (cards.length - 1) / 2) * 7 } satisfies CardMotion;
    });
    setMotions((current) => [...current, ...next]);
  }, []);
  useEffect(() => {
    const before = previousState.current; previousState.current = state;
    if (!before || before.handNumber !== state.handNumber) return;
    const newDiscard = state.latestDiscard && state.latestDiscard.id !== before.latestDiscard?.id ? state.latestDiscard : null;
    const opponentDiscard = newDiscard?.playerId !== state.you.id ? newDiscard : null;
    if (opponentDiscard) animateTransfer(opponentDiscard.cards, false, "discard", playerStacks.current.get(opponentDiscard.playerId) ?? null, discardRef.current);
    const actorId = state.currentPlayerId;
    if (!actorId || actorId === state.you.id || state.turnPhase !== "decision" || before.currentPlayerId !== actorId) return;
    const deckDrawn = state.drawPileCount < before.drawPileCount;
    const exposedBefore = before.drawSourceDiscard?.cards ?? [];
    const exposedNow = new Set((state.drawSourceDiscard?.cards ?? []).map((card) => card.id));
    const exposedCard = exposedBefore.find((card) => !exposedNow.has(card.id));
    if (deckDrawn) animateTransfer([undefined], true, "draw", deckRef.current, playerStacks.current.get(actorId) ?? null, opponentDiscard ? 360 : 0);
    else if (exposedCard) animateTransfer([exposedCard], false, "draw", discardRef.current, playerStacks.current.get(actorId) ?? null, opponentDiscard ? 360 : 0);
  }, [animateTransfer, state]);
  const sort = (kind: "rank" | "suit" | "value") => setOrder([...hand].sort((a, b) => kind === "rank" ? rankIndex(a.rank) - rankIndex(b.rank) : kind === "suit" ? suitOrder[a.suit] - suitOrder[b.suit] || rankIndex(a.rank) - rankIndex(b.rank) : getCardValue(a.rank) - getCardValue(b.rank)).map((card) => card.id));
  const move = (direction: -1 | 1) => { if (activeSelected.length !== 1) return; const index = hand.findIndex((card) => card.id === activeSelected[0]); const target = index + direction; if (target < 0 || target >= hand.length) return; const next = [...hand]; [next[index], next[target]] = [next[target], next[index]]; setOrder(next.map((card) => card.id)); };
  return <YunufShell className="flex h-dvh min-h-dvh flex-col overflow-hidden"><header className="border-b border-white/[.06] bg-black/15 px-4 pb-3 pt-3"><div className="flex items-center justify-between"><button aria-label="Leave match" onClick={() => { if (window.confirm("Leave this Yunuf match? You can rejoin with the same link.")) leave(); }} className="yunuf-icon-button"><LogOut size={14}/></button><div className="text-center"><div className="yunuf-eyebrow">Hand {state.handNumber}</div><div className="mt-0.5 text-[9px] text-white/35">{state.completedRounds}/3 rounds before Show</div></div><button aria-label={muted ? "Turn sound on" : "Mute sound"} onClick={() => setMuted(!muted)} className="yunuf-icon-button">{muted ? <VolumeX size={14}/> : <Volume2 size={14}/>}</button></div></header>
    {state.showState.active && <div className="show-pulse border-b border-[#d7b45a]/25 bg-[#d7b45a]/10 px-4 py-2.5 text-center"><div className="text-[10px] font-black text-[#e8cf8a]">{state.players.find((player) => player.id === state.showState.declarerId)?.name.toUpperCase()} DECLARED SHOW</div><div className="mt-1 text-[8px] text-white/45">Complete the current round · final player: {state.players.find((player) => player.id === state.showState.resolveAfterPlayerId)?.name}</div></div>}
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3"><PlayerRail state={state} registerStack={(playerId, element) => { if (element) playerStacks.current.set(playerId, element); else playerStacks.current.delete(playerId); }}/><div className="mt-3 flex items-center justify-between rounded-xl border border-white/[.06] bg-white/[.025] px-3 py-2"><span className="text-[9px] font-bold text-white/35">{yourTurn ? "YOUR TURN" : `${state.players.find((player) => player.id === state.currentPlayerId)?.name ?? "Table"} IS PLAYING`}</span><TurnClock startedAt={state.turnStartedAt} seconds={state.turnDurationSeconds}/></div>
      <div className="mt-4 grid grid-cols-2 gap-5 px-5"><button ref={deckRef} disabled={!yourTurn || state.turnPhase !== "draw" || loading} onClick={() => { animateTransfer([undefined], true, "draw", deckRef.current, playerStacks.current.get(you.id) ?? null); void mutate({ action: "draw_deck" }); }} className="group text-center disabled:opacity-50"><div className="card-back mx-auto grid h-[96px] w-[68px] place-items-center rounded-lg border-2 border-[#d7b45a]/25"><Layers3 size={20} className="text-[#d7b45a]"/></div><div className="mt-2 text-[9px] font-black text-white/45">DRAW PILE · {state.drawPileCount}</div></button><div className="text-center"><div ref={discardRef} className="relative mx-auto h-[96px] w-[86px]">{state.latestDiscard?.cards.slice(-3).map((card, index) => <span key={card.id} className="absolute" style={{ left: index * 9, transform: `rotate(${(index - 1) * 5}deg)` }}><PlayingCard card={card} small/></span>)}</div><div className="mt-2 text-[9px] font-black text-white/45">LATEST PLAY</div></div></div>
      {yourTurn && state.turnPhase === "draw" && <div className="mt-4 rounded-xl border border-[#d7b45a]/20 bg-[#d7b45a]/[.06] p-3"><div className="text-center text-[9px] font-black text-[#e8cf8a]">DRAW ONE CARD</div><p className="mt-1 text-center text-[8px] text-white/35">Choose the deck or an exposed end from the previous play.</p><div className="mt-3 flex justify-center gap-2">{state.drawSourceDiscard?.cards.filter((card) => sourceIds.includes(card.id)).map((card) => <button key={card.id} aria-label={`Draw ${card.rank} of ${card.suit}`} onClick={(event) => { animateTransfer([card], false, "draw", event.currentTarget, playerStacks.current.get(you.id) ?? null); void mutate({ action: "draw_discard", cardId: card.id }); }}><PlayingCard card={card} tiny/></button>)}</div></div>}
      {error && <YunufError message={error}/>}<div className="mt-4 text-center"><div className="text-[10px] font-black text-[#e8cf8a]">Your hand · {calculateHandValue(hand)} points</div><div className="mt-1 text-[8px] text-white/30">{yourTurn ? state.turnPhase === "discard" ? "Select cards to discard" : state.turnPhase === "draw" ? "Now draw exactly one" : "End your turn or declare Show" : "Plan your next move"}</div></div>
      <div className="mt-3 flex min-h-[130px] items-end overflow-x-auto px-2 pb-2 pt-5">{hand.map((card, index) => <button key={card.id} aria-label={`${card.rank} of ${card.suit}`} aria-pressed={activeSelected.includes(card.id)} disabled={!yourTurn || state.turnPhase !== "discard"} onClick={() => setSelected((ids) => ids.includes(card.id) ? ids.filter((id) => id !== card.id) : [...ids, card.id])} className={`relative shrink-0 transition-transform ${index ? "-ml-4" : ""} ${activeSelected.includes(card.id) ? "z-20 -translate-y-4" : "hover:-translate-y-1"}`}><PlayingCard card={card} selected={activeSelected.includes(card.id)}/></button>)}</div>
      <div className="flex items-center justify-center gap-1.5"><span className="mr-1 text-[8px] font-bold text-white/25">SORT</span>{(["rank","suit","value"] as const).map((kind) => <button key={kind} onClick={() => sort(kind)} className="min-h-8 rounded-md border border-white/[.07] px-2 text-[8px] font-bold uppercase text-white/40">{kind}</button>)}<button aria-label="Move selected card left" disabled={activeSelected.length !== 1} onClick={() => move(-1)} className="yunuf-mini-button"><ChevronLeft size={12}/></button><button aria-label="Move selected card right" disabled={activeSelected.length !== 1} onClick={() => move(1)} className="yunuf-mini-button"><ChevronRight size={12}/></button></div>
    </div>
    <div className="border-t border-white/[.07] bg-[#121a18]/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">{yourTurn && state.turnPhase === "discard" && <><div className={`mb-2 text-center text-[9px] font-bold ${activeSelected.length && validation.valid ? "text-emerald-200" : "text-white/35"}`}>{!activeSelected.length ? "Choose one card, a pair, or a 3+ card run" : validation.valid ? `Valid ${validation.playType}${validation.playType === "sequence" ? ` · ${validation.orderedCards.map((card) => card.rank).join(" → ")}` : ""}` : validation.error}</div><YunufButton disabled={loading || !validation.valid} onClick={async () => { animateTransfer(selectedCards, false, "discard", playerStacks.current.get(you.id) ?? null, discardRef.current); const result = await mutate({ action: "discard", cardIds: activeSelected }); if (result) setSelected([]); }}><ArrowDownToLine size={15}/>Discard {activeSelected.length || "cards"}</YunufButton></>}
      {yourTurn && state.turnPhase === "draw" && <div className="text-center text-[10px] font-bold text-[#e8cf8a]">Choose one card to draw above</div>}
      {yourTurn && state.turnPhase === "decision" && <div className="grid grid-cols-2 gap-2"><YunufButton secondary disabled={loading} onClick={() => mutate({ action: "end_turn" })}>End turn<ArrowRight size={14}/></YunufButton><YunufButton disabled={loading || state.completedRounds < 3 || state.showState.active} onClick={() => setShowConfirm(true)}><Eye size={14}/>{state.showState.active ? "Show active" : state.completedRounds < 3 ? `Locked · ${3-state.completedRounds} round${3-state.completedRounds === 1 ? "" : "s"}` : "Declare Show"}</YunufButton></div>}
      {!yourTurn && <div className="flex min-h-11 items-center justify-center gap-2 text-[10px] font-bold text-white/35"><Clock3 size={13}/>Waiting for {state.players.find((player) => player.id === state.currentPlayerId)?.name}</div>}</div>
    <CardMotionLayer motions={motions} onDone={(id) => setMotions((current) => current.filter((motion) => motion.id !== id))}/>
    {showConfirm && <div className="absolute inset-0 z-50 grid place-items-center bg-black/70 p-5 backdrop-blur-sm"><div role="dialog" aria-modal="true" aria-labelledby="show-title" className="w-full max-w-sm rounded-2xl border border-[#d7b45a]/30 bg-[#17221e] p-5 shadow-2xl"><ShieldAlert className="text-[#e8cf8a]" size={25}/><h2 id="show-title" className="mt-3 text-xl font-black">Declare Show?</h2><p className="mt-2 text-[11px] leading-5 text-white/45">Every player who has not acted this round gets one final normal turn. Then all hands are revealed.</p><div className="mt-4 rounded-xl bg-black/20 p-3 text-center"><div className="text-[8px] font-black tracking-wider text-white/35">YOUR HAND</div><div className="mt-1 text-2xl font-black text-[#e8cf8a]">{calculateHandValue(hand)} points</div></div><div className="mt-5 grid grid-cols-2 gap-2"><YunufButton secondary onClick={() => setShowConfirm(false)}>Cancel</YunufButton><YunufButton onClick={() => { setShowConfirm(false); void mutate({ action: "declare_show" }); }}>Confirm Show</YunufButton></div></div></div>}
  </YunufShell>;
}

function PlayerRail({ state, registerStack }: { state: YunufViewState; registerStack: (playerId: string, element: HTMLDivElement | null) => void }) { return <div className="flex gap-2 overflow-x-auto pb-1">{state.players.map((player) => <div key={player.id} className={`min-w-[116px] rounded-xl border p-2.5 transition-colors ${player.id === state.currentPlayerId ? "border-[#d7b45a]/45 bg-[#d7b45a]/10" : "border-white/[.06] bg-white/[.025]"}`}><div className="flex items-center gap-2"><Avatar index={player.avatar} size="sm"/><div className="min-w-0 flex-1"><div className="truncate text-[9px] font-black">{player.id === state.you.id ? "You" : player.name}</div><div className="mt-0.5 flex items-center justify-between text-[7px] text-white/30"><span>Score</span><b className={player.totalScore >= state.eliminationScore * .75 ? "text-red-300" : "text-[#e8cf8a]"}>{player.totalScore}</b></div></div></div><PhysicalHand ref={(element) => registerStack(player.id, element)} count={player.cardCount} active={player.id === state.currentPlayerId}/></div>)}</div>; }

function PhysicalHand({ count, active, ref }: { count: number; active: boolean; ref: React.Ref<HTMLDivElement> }) {
  const visibleCards = Math.min(count, 9); const width = visibleCards ? 20 + (visibleCards - 1) * 7 : 20;
  return <div ref={ref} aria-label={`${count} cards in hand`} className={`relative mx-auto mt-2 h-8 transition-transform ${active ? "yunuf-hand-active" : ""}`} style={{ width }}>{Array.from({ length: visibleCards }, (_, index) => <span key={index} className="yunuf-player-card-back absolute bottom-0" style={{ left: index * 7, transform: `rotate(${(index - (visibleCards - 1) / 2) * 2.2}deg)` }}/>)}</div>;
}

function CardMotionLayer({ motions, onDone }: { motions: CardMotion[]; onDone: (id: string) => void }) {
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">{motions.map((motion) => {
    const style = {
      "--from-x": `${motion.from.x}px`, "--from-y": `${motion.from.y}px`, "--via-x": `${motion.via.x}px`, "--via-y": `${motion.via.y}px`, "--to-x": `${motion.to.x}px`, "--to-y": `${motion.to.y}px`, "--motion-rotation": `${motion.rotation}deg`, animationDelay: `${motion.delay}ms`,
    } as React.CSSProperties;
    return <div key={motion.id} className={`yunuf-card-motion yunuf-card-motion-${motion.kind}`} style={style} onAnimationEnd={() => onDone(motion.id)}>{motion.faceDown || !motion.card ? <span className="card-back yunuf-motion-card-back"/> : <PlayingCard card={motion.card} tiny/>}</div>;
  })}</div>;
}

function TurnClock({ startedAt, seconds }: { startedAt: number | null; seconds: number }) { const [now, setNow] = useState<number | null>(null); useEffect(() => { const tick = () => setNow(Date.now()); const timer = window.setInterval(tick, 500); return () => window.clearInterval(timer); }, []); const left = startedAt && now ? Math.max(0, Math.ceil((startedAt + seconds * 1000 - now) / 1000)) : seconds; return <span className={`inline-flex items-center gap-1 text-[10px] font-black ${left <= 8 ? "text-red-300" : "text-[#e8cf8a]"}`}><Clock3 size={11}/>{left}s</span>; }

function YunufResults({ state, loading, mutate, leave }: GameProps) { const result = state.result!; return <YunufShell className="px-5 pb-8 pt-7"><div className="flex justify-between"><button onClick={leave} className="yunuf-icon-button"><House size={15}/></button><YunufMark/><span className="size-11"/></div><div className="mt-7 text-center"><div className="yunuf-eyebrow">Hand {state.handNumber} revealed</div><Trophy className="mx-auto mt-5 text-[#e8cf8a]" size={34}/><h1 className="mt-3 text-[27px] font-black">{result.winnerIds.length > 1 ? "Joint winners!" : `${state.players.find((player) => player.id === result.winnerIds[0])?.name} wins the hand`}</h1><p className="mt-2 text-[10px] text-white/40">{state.players.find((player) => player.id === result.declarerId)?.name} declared Show.</p></div><div className="mt-7 space-y-3">{[...state.players].sort((a,b) => (result.handValues[a.id] ?? 99)-(result.handValues[b.id] ?? 99)).map((player) => <div key={player.id} className={`rounded-xl border p-3 ${result.winnerIds.includes(player.id) ? "border-[#d7b45a]/35 bg-[#d7b45a]/10" : "border-white/[.07] bg-white/[.025]"}`}><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Avatar index={player.avatar} size="sm"/><div><div className="text-[10px] font-black">{player.name}{player.id === result.declarerId ? " · SHOW" : ""}</div><div className="mt-0.5 text-[8px] text-white/35">+{result.roundScores[player.id]} this hand · {player.totalScore} total</div></div></div><div className="text-xl font-black text-[#e8cf8a]">{result.handValues[player.id]}</div></div><div className="mt-3 flex gap-1 overflow-x-auto">{player.hand?.map((card) => <PlayingCard key={card.id} card={card} tiny reveal/>)}</div>{result.eliminatedIds.includes(player.id) && <div className="mt-2 text-[8px] font-black text-red-300">ELIMINATED AT {player.totalScore}</div>}{player.id === result.declarerId && !result.declarerWon && <div className="mt-2 text-[8px] font-black text-red-300">+10 FAILED SHOW PENALTY</div>}</div>)}</div>{state.you.id === state.hostPlayerId ? <YunufButton className="mt-6" disabled={loading} onClick={() => mutate({ action: "continue" })}><RotateCcw size={14}/>Deal next hand</YunufButton> : <p className="mt-6 text-center text-[10px] text-white/35">Waiting for the host to deal…</p>}</YunufShell>; }

function YunufMatchOver({ state, loading, mutate, leave }: GameProps) { const winners = state.result?.matchWinnerIds ?? []; return <YunufShell className="flex flex-col px-6 pb-8 pt-8"><button onClick={leave} className="yunuf-icon-button"><House size={15}/></button><div className="flex flex-1 flex-col justify-center text-center"><div className="relative mx-auto grid size-28 place-items-center rounded-full border border-[#d7b45a]/35 bg-[#d7b45a]/10 shadow-[0_0_70px_rgba(215,180,90,.25)]"><Crown size={42} className="text-[#e8cf8a]"/><Sparkles className="absolute -right-1 top-1 text-[#e8cf8a]"/></div><div className="yunuf-eyebrow mt-8">Match complete</div><h1 className="mt-3 text-[34px] font-black">{winners.length > 1 ? "Joint champions" : `${state.players.find((player) => player.id === winners[0])?.name} wins Yunuf`}</h1><div className="mt-6 space-y-2">{[...state.players].sort((a,b) => a.totalScore-b.totalScore).map((player) => <div key={player.id} className="rounded-xl border border-white/[.07] bg-white/[.025] px-4 py-3"><div className="flex items-center justify-between"><span className="text-[11px] font-black">{player.name}</span><span className="text-[11px] font-black text-[#e8cf8a]">{player.totalScore} pts</span></div><div className="mt-1 text-left text-[8px] text-white/30">{player.handsWon} wins · {player.showsDeclared} Shows · {player.failedShows} failed</div></div>)}</div></div><div className="grid grid-cols-2 gap-2">{state.you.id === state.hostPlayerId ? <YunufButton onClick={() => mutate({ action: "reset" })} disabled={loading}><RotateCcw size={14}/>Play again</YunufButton> : <div className="grid place-items-center text-[9px] text-white/35">Host can restart</div>}<YunufButton secondary onClick={leave} disabled={loading}>Leave room</YunufButton></div></YunufShell>; }

function PlayingCard({ card, selected, small, tiny, decorative, reveal, className = "", style }: { card: Card; selected?: boolean; small?: boolean; tiny?: boolean; decorative?: boolean; reveal?: boolean; className?: string; style?: React.CSSProperties }) { const red = card.suit === "hearts" || card.suit === "diamonds"; const dimensions = tiny ? "h-[62px] w-[43px] rounded-md" : small ? "h-[96px] w-[68px] rounded-lg" : "h-[112px] w-[76px] rounded-lg"; return <span aria-hidden={decorative || undefined} style={style} className={`${reveal ? "card-reveal" : ""} ${dimensions} ${selected ? "ring-2 ring-[#d7b45a] shadow-[0_0_22px_rgba(215,180,90,.3)]" : ""} ${className} relative block border border-black/15 bg-[#faf4df] p-1.5 text-left shadow-[0_7px_16px_rgba(0,0,0,.32)] ${red ? "text-[#a52a31]" : "text-[#151b19]"}`}><b className={`${tiny ? "text-[12px]" : "text-[17px]"} block leading-none`}>{card.rank}</b><span className={`${tiny ? "text-[11px]" : "text-[16px]"} leading-none`}>{suitSymbol[card.suit]}</span><span className={`${tiny ? "text-[18px]" : "text-[28px]"} absolute inset-0 grid place-items-center opacity-90`}>{suitSymbol[card.suit]}</span></span>; }
function YunufButton({ children, secondary, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) { return <button className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border px-4 text-[11px] font-black transition active:scale-[.985] disabled:opacity-35 ${secondary ? "border-[#d7b45a]/40 bg-transparent text-[#e8cf8a]" : "border-transparent bg-[#d7b45a] text-[#17201d] shadow-[0_8px_25px_rgba(215,180,90,.16)]"} ${className}`} {...props}>{children}</button>; }
function YunufError({ message }: { message: string }) { return <div role="alert" className="mt-4 rounded-lg border border-red-300/20 bg-red-400/10 px-3 py-2 text-center text-[10px] font-bold text-red-200">{message}</div>; }
