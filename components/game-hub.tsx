import Link from "next/link";
import { ArrowRight, Heart, MessageCircle, Sparkles, Users } from "lucide-react";
import { Screen } from "./ui";

export function GameHub() {
  return <Screen plum className="min-h-dvh px-5 pb-8 pt-8">
    <header>
      <div className="inline-flex items-center gap-2 rounded-full border border-[var(--coral)]/20 bg-[var(--coral)]/10 px-3 py-1.5 text-[9px] font-black tracking-[.14em] text-[var(--peach)]"><Sparkles size={11}/> PLAY TOGETHER</div>
      <h1 className="headline mt-5 text-[34px] font-black">Pick a game for<br/>your favourite people.</h1>
      <p className="mt-3 max-w-[320px] text-[12px] leading-5 text-[var(--muted)]">Private rooms, shared laughs, and no accounts to create.</p>
    </header>

    <section className="mt-9" aria-labelledby="couples-heading">
      <CategoryHeading id="couples-heading" icon={Heart} title="Couples" players="2 players"/>
      <Link href="/games/15-words" className="group relative mt-3 block overflow-hidden rounded-2xl border border-[var(--coral)]/25 bg-[linear-gradient(145deg,var(--plum-2),#21131f)] p-5 shadow-[0_18px_50px_rgba(0,0,0,.24)] transition active:scale-[.99]">
        <div aria-hidden className="absolute -right-8 -top-10 size-36 rounded-full bg-[var(--coral)]/10 blur-2xl"/>
        <div className="relative flex items-start gap-4">
          <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-[var(--coral)]/25 bg-black/20 shadow-[inset_0_0_28px_rgba(255,98,104,.08)]"><span className="text-[22px] font-black text-[var(--peach)]">15</span></div>
          <div className="min-w-0 flex-1 pt-0.5"><div className="eyebrow text-[var(--coral)]">Word game</div><h2 className="mt-1 text-xl font-black">15 Words</h2><p className="mt-2 text-[10px] leading-4 text-white/45">Help your partner guess eight secret words with only fifteen clue words.</p></div>
        </div>
        <div className="relative mt-5 flex items-center justify-between border-t border-white/[.07] pt-4"><span className="inline-flex items-center gap-1.5 text-[9px] font-bold text-white/40"><MessageCircle size={11}/> Private room</span><span className="inline-flex items-center gap-2 text-[11px] font-black text-[var(--peach)]">Play now <ArrowRight size={14} className="transition-transform group-hover:translate-x-1"/></span></div>
      </Link>
    </section>

    <section className="mt-8" aria-labelledby="friends-heading">
      <CategoryHeading id="friends-heading" icon={Users} title="Friends" players="2+ players"/>
      <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-white/[.025] px-5 py-7 text-center"><Users className="mx-auto text-white/20" size={22}/><h2 className="mt-3 text-[12px] font-black text-white/55">More games are joining soon</h2><p className="mt-1.5 text-[10px] leading-4 text-white/30">Party games built for the whole group will live here.</p></div>
    </section>

    <footer className="mt-8 text-center text-[9px] font-semibold text-white/25">Made for the people you never run out of things to say to.</footer>
  </Screen>;
}

function CategoryHeading({ id, icon: Icon, title, players }: { id: string; icon: typeof Heart; title: string; players: string }) {
  return <div className="flex items-center justify-between"><h2 id={id} className="flex items-center gap-2 text-[13px] font-black text-[var(--peach)]"><span className="grid size-7 place-items-center rounded-lg bg-white/[.05] text-[var(--coral)]"><Icon size={13}/></span>{title}</h2><span className="rounded-full border border-white/[.07] bg-white/[.035] px-2.5 py-1 text-[9px] font-bold text-white/35">{players}</span></div>;
}
