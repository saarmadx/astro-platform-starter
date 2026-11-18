// The Post section: plan when each clip goes up, keep its upload text and checklist in one place,
// learn which posting times work for this channel, and read short how-to guides.
// Everything is stored in this browser only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Bell, BellRing, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, ExternalLink, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { Clip, Project } from '../lib/types';

type Check = 'exported' | 'uploaded' | 'scheduled' | 'pinned';
export type PlanItem = { id: string; projectId: string; clipId: string; at: number; done: Partial<Record<Check, boolean>>; posted?: boolean; views?: number };
export type Plan = { hours: number[]; items: PlanItem[]; youtubeHours?: boolean };

const KEY = 'clipsmith.plan';
/** starting points to test until the channel has its own numbers */
const DEFAULT_HOURS = [12, 17, 20];
const CHECKS: { id: Check; label: string }[] = [
    { id: 'exported', label: 'Exported' },
    { id: 'uploaded', label: 'Uploaded' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'pinned', label: 'Pinned comment' }
];
const DAY = 86400000;

function loadPlan(): Plan {
    try {
        const p = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        if (p && Array.isArray(p.items) && Array.isArray(p.hours)) return p;
    } catch {}
    return { hours: DEFAULT_HOURS, items: [] };
}
function savePlan(p: Plan) {
    try {
        localStorage.setItem(KEY, JSON.stringify(p));
    } catch {}
}

const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};
const atHour = (day: number, h: number) => {
    const d = new Date(day);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
};
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const tags = (c: Clip) => c.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
const uploadText = (c: Clip) => `${c.title}\n\n${c.description}\n\n${tags(c)}`.replace(/\n{3,}/g, '\n\n').trim();
const PINNED = ['What would you have done? 👇', 'Full stream on the channel 👆 Subscribe for more', 'Rate this from 1 to 10 😂'];

type Entry = { project: Project; clip: Clip };

export default function Planner({ projects, onOpenClip }: { projects: Project[]; onOpenClip: (projectId: string, clipId: string) => void }) {
    const [plan, setPlanState] = useState<Plan>({ hours: DEFAULT_HOURS, items: [] });
    const [tab, setTab] = useState<'plan' | 'times' | 'guides'>('plan');
    const [week, setWeek] = useState(0);
    const [open, setOpen] = useState<string | null>(null);
    const [copied, setCopied] = useState('');
    const [now, setNow] = useState(Date.now());
    const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
    const notified = useRef(new Set<string>());

    useEffect(() => {
        setPlanState(loadPlan());
        setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
        const t = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(t);
    }, []);
    const setPlan = (p: Plan) => {
        setPlanState(p);
        savePlan(p);
    };

    const entries = useMemo(() => {
        const m = new Map<string, Entry>();
        for (const p of projects) for (const c of p.clips) m.set(`${p.id}|${c.id}`, { project: p, clip: c });
        return m;
    }, [projects]);
    const entryOf = (i: PlanItem) => entries.get(`${i.projectId}|${i.clipId}`);
    // planned clips whose project or clip was deleted are dropped
    const items = plan.items.filter((i) => entryOf(i));
    const planned = new Set(items.map((i) => `${i.projectId}|${i.clipId}`));
    const unplanned = [...entries.values()].filter((e) => e.project.status === 'ready' && !planned.has(`${e.project.id}|${e.clip.id}`)).sort((a, b) => b.clip.score - a.clip.score);
    const hours = [...plan.hours].sort((a, b) => a - b);

    // ---------- reminders ----------
    const due = items.filter((i) => !i.posted && i.at <= now && now - i.at < 6 * 3600000).sort((a, b) => a.at - b.at);
    useEffect(() => {
        if (perm !== 'granted') return;
        for (const i of due) {
            if (notified.current.has(i.id) || now - i.at > 15 * 60000) continue;
            notified.current.add(i.id);
            const e = entryOf(i);
            try {
                new Notification('Time to post on YouTube 🎬', { body: e?.clip.title ?? 'A planned clip is due', tag: i.id });
            } catch {}
        }
    }, [now, perm, due.length]);

    // ---------- editing ----------
    const update = (id: string, patch: Partial<PlanItem>) => setPlan({ ...plan, items: plan.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
    const remove = (id: string) => setPlan({ ...plan, items: plan.items.filter((i) => i.id !== id) });
    const slotTaken = (t: number) => items.some((i) => i.at === t);
    const place = (key: string, at: number) => {
        const [projectId, clipId] = key.split('|');
        if (key.startsWith('item:')) {
            const id = key.slice(5);
            const other = items.find((i) => i.at === at && i.id !== id);
            const moving = items.find((i) => i.id === id);
            // dropping on a taken slot swaps the two clips
            setPlan({ ...plan, items: plan.items.map((i) => (i.id === id ? { ...i, at } : other && i.id === other.id && moving ? { ...i, at: moving.at } : i)) });
            return;
        }
        if (slotTaken(at)) return;
        setPlan({ ...plan, items: [...plan.items, { id: `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, projectId, clipId, at, done: {} }] });
    };
    /** future slots from now on, day by day */
    const freeSlots = (count: number) => {
        const out: number[] = [];
        for (let d = 0; d < 60 && out.length < count; d++)
            for (const h of hours) {
                const t = atHour(startOfDay(now) + d * DAY, h);
                if (t > now + 10 * 60000 && !slotTaken(t) && !out.includes(t)) out.push(t);
                if (out.length >= count) break;
            }
        return out;
    };
    const addNext = (e: Entry) => {
        const [t] = freeSlots(1);
        if (t) place(`${e.project.id}|${e.clip.id}`, t);
    };
    /** best clips into the free slots of the next week; avoids two clips from the same video in a row */
    const autoFill = () => {
        const slots = freeSlots(hours.length * 7);
        const pool = [...unplanned];
        const added: PlanItem[] = [];
        let lastProject = '';
        for (const t of slots) {
            if (!pool.length) break;
            let k = pool.findIndex((e) => e.project.id !== lastProject);
            if (k < 0) k = 0;
            const e = pool.splice(k, 1)[0];
            lastProject = e.project.id;
            added.push({ id: `pl${t.toString(36)}${e.clip.id}`, projectId: e.project.id, clipId: e.clip.id, at: t, done: {} });
        }
        setPlan({ ...plan, items: [...plan.items, ...added] });
    };
    const copy = async (text: string, what: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(what);
            setTimeout(() => setCopied(''), 1500);
        } catch {}
    };

    // ---------- warnings ----------
    const sameMoment = (i: PlanItem) => {
        const a = entryOf(i)!.clip;
        return items.some((j) => {
            if (j.id === i.id || j.projectId !== i.projectId) return false;
            const b = entryOf(j)!.clip;
            const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
            return overlap > 0.5 * Math.min(a.end - a.start, b.end - b.start);
        });
    };
    const weekStart = startOfDay(now) + week * 7 * DAY;
    const days = Array.from({ length: 7 }, (_, d) => weekStart + d * DAY);
    const emptyDays = days.filter((d) => d + DAY > now && !items.some((i) => i.at >= d && i.at < d + DAY));

    // ---------- your best times ----------
    const results = items.filter((i) => i.posted && typeof i.views === 'number');
    const byHour = new Map<number, number[]>();
    for (const i of results) {
        const h = new Date(i.at).getHours();
        byHour.set(h, [...(byHour.get(h) ?? []), i.views!]);
    }
    const ranked = [...byHour.entries()].map(([h, v]) => ({ h, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length })).sort((a, b) => b.avg - a.avg);
    const maxAvg = Math.max(1, ...ranked.map((r) => r.avg));

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="!text-3xl">Post planner</h1>
                    <p className="mt-1 text-muted">Plan when each clip goes up, keep its upload text ready, and find your channel’s best times.</p>
                </div>
                <div className="flex gap-1 rounded-xl bg-black/30 p-1" role="tablist">
                    {(
                        [
                            ['plan', 'Calendar', CalendarDays],
                            ['times', 'Best times', BarChart3],
                            ['guides', 'Guides', BookOpen]
                        ] as const
                    ).map(([id, label, Icon]) => (
                        <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === id ? 'bg-accent text-ink' : 'text-muted hover:text-white'}`}>
                            <Icon size={15} /> {label}
                        </button>
                    ))}
                </div>
            </div>

            {due.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3">
                    <BellRing size={18} className="text-accent" />
                    <span className="text-sm font-semibold">
                        {due.length === 1 ? 'A clip is due now: ' : `${due.length} clips are due: `}
                        <span className="font-normal">{due.map((i) => entryOf(i)!.clip.title).join(' · ')}</span>
                    </span>
                    <button className="tl-btn ml-auto" onClick={() => setOpen(due[0].id)}>Open it</button>
                </div>
            )}

            {tab === 'plan' && (
                <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
                    {/* clips not planned yet */}
                    <aside className="panel flex max-h-[78vh] flex-col overflow-hidden">
                        <div className="flex items-center justify-between gap-2 border-b border-white/10 p-3">
                            <p className="text-sm font-bold">Ready to post <span className="text-muted">({unplanned.length})</span></p>
                            <button className="tl-btn" disabled={!unplanned.length} onClick={autoFill} title="Put your best clips into the free slots of the next 7 days">
                                <Sparkles size={13} /> Auto-fill week
                            </button>
                        </div>
                        <div className="flex flex-col gap-2 overflow-y-auto p-3">
                            {unplanned.length === 0 && <p className="text-sm text-muted">{entries.size ? 'Every clip is planned. 🎉' : 'Finished clips from your projects show up here.'}</p>}
                            {unplanned.map((e) => (
                                <div
                                    key={`${e.project.id}|${e.clip.id}`}
                                    draggable
                                    onDragStart={(ev) => ev.dataTransfer.setData('text/plain', `${e.project.id}|${e.clip.id}`)}
                                    className="flex cursor-grab items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2 hover:border-white/25 active:cursor-grabbing"
                                    title="Drag into a slot on the calendar"
                                >
                                    <Thumb clip={e.clip} />
                                    <div className="min-w-0 flex-1">
                                        <p className="line-clamp-2 text-xs font-semibold">{e.clip.title}</p>
                                        <p className="truncate text-[11px] text-muted">
                                            {e.clip.score} · {e.project.name}
                                        </p>
                                    </div>
                                    <button className="tl-icon !size-7 shrink-0" onClick={() => addNext(e)} title="Add to the next free slot" aria-label="Add to the next free slot">
                                        <Plus size={15} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </aside>

                    {/* calendar */}
                    <section className="panel flex min-w-0 flex-col overflow-hidden">
                        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
                            <button className="tl-icon" onClick={() => setWeek(week - 1)} aria-label="Previous week"><ChevronLeft size={16} /></button>
                            <button className="tl-icon" onClick={() => setWeek(week + 1)} aria-label="Next week"><ChevronRight size={16} /></button>
                            <span className="text-sm font-semibold">{week === 0 ? 'Next 7 days' : `${dayLabel(days[0])} – ${dayLabel(days[6])}`}</span>
                            {week !== 0 && <button className="text-xs text-muted hover:text-white" onClick={() => setWeek(0)}>Today</button>}
                            <span className="ml-auto flex items-center gap-1 text-xs text-muted"><Clock size={13} /> {tz} · {hours.length} post{hours.length === 1 ? '' : 's'} a day</span>
                        </div>
                        {emptyDays.length > 0 && items.length > 0 && (
                            <p className="flex items-center gap-2 border-b border-white/10 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">
                                <AlertTriangle size={13} /> {emptyDays.length === 1 ? `Nothing planned on ${dayLabel(emptyDays[0])}.` : `${emptyDays.length} days this week have nothing planned.`} Posting every day keeps the channel growing.
                            </p>
                        )}
                        <div className="overflow-x-auto">
                            <div className="grid min-w-[760px] grid-cols-7">
                                {days.map((d) => (
                                    <div key={d} className="border-r border-white/[0.06] last:border-r-0">
                                        <p className={`border-b border-white/[0.06] px-2 py-2 text-center text-xs font-bold ${startOfDay(now) === d ? 'text-accent' : 'text-white/70'}`}>{startOfDay(now) === d ? `Today · ${dayLabel(d).split(' ').slice(1).join(' ')}` : dayLabel(d)}</p>
                                        <div className="flex flex-col gap-2 p-2">
                                            {hours.map((h) => {
                                                const t = atHour(d, h);
                                                const it = items.find((i) => i.at === t);
                                                const past = t < now;
                                                return (
                                                    <div
                                                        key={h}
                                                        onDragOver={(ev) => ev.preventDefault()}
                                                        onDrop={(ev) => {
                                                            ev.preventDefault();
                                                            place(ev.dataTransfer.getData('text/plain'), t);
                                                        }}
                                                        className={`min-h-[86px] rounded-lg border p-1.5 ${it ? 'border-white/15 bg-white/[0.04]' : past ? 'border-dashed border-white/5' : 'border-dashed border-white/15 hover:border-accent/50'}`}
                                                    >
                                                        <p className="mb-1 text-[10px] font-semibold text-white/40">{hourLabel(h)}</p>
                                                        {it ? <SlotCard item={it} entry={entryOf(it)!} warn={sameMoment(it)} onOpen={() => setOpen(it.id)} /> : <p className="pt-3 text-center text-[10px] text-white/25">{past ? '' : 'Drop a clip'}</p>}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <PostingHours hours={plan.hours} onChange={(h) => setPlan({ ...plan, hours: h.length ? h : plan.hours })} />
                        <div className="flex flex-wrap items-center gap-3 border-t border-white/10 p-3 text-xs text-muted">
                            {perm === 'granted' ? (
                                <span className="flex items-center gap-1.5 text-emerald-300"><Bell size={13} /> Reminders on: you get a notification when a clip is due (while Clipsmith is open).</span>
                            ) : perm === 'unsupported' ? (
                                <span>This browser can’t show reminders; the banner at the top shows clips that are due.</span>
                            ) : (
                                <>
                                    <span>Get a notification when it’s time to post (while Clipsmith is open).</span>
                                    <button className="tl-btn" onClick={() => Notification.requestPermission().then(setPerm)}><Bell size={13} /> Turn on reminders</button>
                                </>
                            )}
                        </div>
                    </section>
                </div>
            )}

            {tab === 'times' && (
                <div className="grid gap-5 lg:grid-cols-2">
                    <section className="panel flex flex-col gap-3 p-5">
                        <h2 className="text-lg font-bold">1. Use your channel’s numbers</h2>
                        <p className="text-sm text-muted">The best times are different for every channel. YouTube shows yours:</p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm">
                            <li>Open <b>YouTube Studio</b> → <b>Analytics</b> → <b>Audience</b>.</li>
                            <li>Find the card <b>“When your viewers are on YouTube”</b>. Darker purple = more of your viewers online.</li>
                            <li>Pick the 2–4 darkest hours below. Posting about an hour before the peak gives a Short time to get going.</li>
                        </ol>
                        <a className="tl-btn self-start" href="https://studio.youtube.com" target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open YouTube Studio</a>
                        <PostingHours hours={plan.hours} onChange={(h) => setPlan({ ...plan, hours: h.length ? h : plan.hours, youtubeHours: true })} big />
                        {!plan.youtubeHours && <p className="text-xs text-muted">Not enough data on your channel yet? Start with lunchtime, after school/work and evening ({DEFAULT_HOURS.map(hourLabel).join(', ')}), then let your own results below decide.</p>}
                    </section>
                    <section className="panel flex flex-col gap-3 p-5">
                        <h2 className="text-lg font-bold">2. Learn from your own posts</h2>
                        <p className="text-sm text-muted">After a clip has been up for a day, open it in the calendar, tick <b>Posted</b> and type its views. Clipsmith shows which posting times work best for you.</p>
                        {ranked.length === 0 ? (
                            <p className="rounded-lg bg-white/[0.04] p-3 text-sm text-muted">No results yet. Add views for a few posted clips to see this chart.</p>
                        ) : (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    {ranked.map((r) => (
                                        <div key={r.h} className="flex items-center gap-2 text-sm">
                                            <span className="w-14 shrink-0 text-xs text-muted">{hourLabel(r.h)}</span>
                                            <div className="h-5 flex-1 overflow-hidden rounded bg-white/[0.05]">
                                                <div className="h-full rounded bg-accent/80" style={{ width: `${(r.avg / maxAvg) * 100}%` }} />
                                            </div>
                                            <span className="w-28 shrink-0 text-right text-xs tabular-nums">{Math.round(r.avg).toLocaleString()} avg · {r.n} post{r.n > 1 ? 's' : ''}</span>
                                        </div>
                                    ))}
                                </div>
                                {results.length >= 6 ? (
                                    <button className="tl-btn self-start" onClick={() => setPlan({ ...plan, hours: ranked.slice(0, Math.max(1, hours.length)).map((r) => r.h) })}>
                                        <Sparkles size={13} /> Post at my {Math.max(1, hours.length)} best times
                                    </button>
                                ) : (
                                    <p className="text-xs text-muted">Add {6 - results.length} more result{6 - results.length === 1 ? '' : 's'} before trusting this; one viral clip can skew a small sample.</p>
                                )}
                            </>
                        )}
                    </section>
                </div>
            )}

            {tab === 'guides' && <Guides />}

            {open && (() => {
                const it = items.find((i) => i.id === open);
                const e = it && entryOf(it);
                if (!it || !e) return null;
                return (
                    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setOpen(null)}>
                        <div className="panel flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto p-5" onClick={(ev) => ev.stopPropagation()}>
                            <div className="flex items-start gap-3">
                                <Thumb clip={e.clip} big />
                                <div className="min-w-0 flex-1">
                                    <p className="font-bold">{e.clip.title}</p>
                                    <p className="text-xs text-muted">{e.project.name}</p>
                                    <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                                        Post at
                                        <input
                                            type="datetime-local"
                                            className="input !w-auto !py-1 text-xs"
                                            value={toLocalInput(it.at)}
                                            onChange={(ev) => ev.target.value && update(it.id, { at: new Date(ev.target.value).getTime() })}
                                        />
                                    </label>
                                </div>
                            </div>
                            {sameMoment(it) && <p className="flex items-center gap-2 rounded-lg bg-amber-300/10 px-3 py-2 text-xs text-amber-100"><AlertTriangle size={13} /> Another planned clip shows the same moment. Viewers may see it twice.</p>}
                            <div className="flex flex-col gap-2">
                                <p className="text-sm font-semibold">Upload text</p>
                                <pre className="max-h-40 overflow-y-auto rounded-lg bg-black/30 p-3 text-xs whitespace-pre-wrap">{uploadText(e.clip)}</pre>
                                <div className="flex flex-wrap gap-2">
                                    <button className="tl-btn" onClick={() => copy(e.clip.title, 'title')}><Copy size={13} /> {copied === 'title' ? 'Copied!' : 'Copy title'}</button>
                                    <button className="tl-btn" onClick={() => copy(uploadText(e.clip).slice(e.clip.title.length).trim(), 'desc')}><Copy size={13} /> {copied === 'desc' ? 'Copied!' : 'Copy description + hashtags'}</button>
                                </div>
                            </div>
                            <div className="flex flex-col gap-2">
                                <p className="text-sm font-semibold">Pinned comment ideas</p>
                                <div className="flex flex-wrap gap-2">
                                    {PINNED.map((c) => (
                                        <button key={c} className="tl-btn" onClick={() => copy(c, c)}>{copied === c ? 'Copied!' : c}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-col gap-2">
                                <p className="text-sm font-semibold">Checklist</p>
                                <div className="grid grid-cols-2 gap-2">
                                    {CHECKS.map((c) => (
                                        <label key={c.id} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                                            <input type="checkbox" className="accent-[var(--color-accent)]" checked={!!it.done[c.id]} onChange={(ev) => update(it.id, { done: { ...it.done, [c.id]: ev.target.checked } })} />
                                            {c.label}
                                        </label>
                                    ))}
                                </div>
                                <label className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm font-semibold">
                                    <input type="checkbox" className="accent-[var(--color-accent)]" checked={!!it.posted} onChange={(ev) => update(it.id, { posted: ev.target.checked })} />
                                    Posted (it’s live)
                                </label>
                                {it.posted && (
                                    <label className="flex items-center gap-2 text-sm">
                                        Views after about a day
                                        <input type="number" min={0} className="input !w-32 !py-1" value={it.views ?? ''} onChange={(ev) => update(it.id, { views: ev.target.value === '' ? undefined : Math.max(0, +ev.target.value) })} placeholder="e.g. 1200" />
                                    </label>
                                )}
                            </div>
                            <div className="flex flex-wrap justify-between gap-2 border-t border-white/10 pt-3">
                                <button className="tl-btn text-red-300" onClick={() => { remove(it.id); setOpen(null); }}><Trash2 size={13} /> Remove from plan</button>
                                <div className="flex gap-2">
                                    <button className="tl-btn" onClick={() => onOpenClip(e.project.id, e.clip.id)}>Edit / export clip</button>
                                    <button className="btn-accent !px-4 !py-1.5 text-sm" onClick={() => setOpen(null)}>Done</button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

function toLocalInput(t: number) {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Thumb({ clip, big }: { clip: Clip; big?: boolean }) {
    const cls = big ? 'h-24 w-14' : 'h-12 w-8';
    return clip.thumb ? <img src={clip.thumb} alt="" className={`${cls} shrink-0 rounded object-cover`} /> : <span className={`${cls} shrink-0 rounded bg-white/10`} />;
}

function SlotCard({ item, entry, warn, onOpen }: { item: PlanItem; entry: Entry; warn: boolean; onOpen: () => void }) {
    const doneCount = CHECKS.filter((c) => item.done[c.id]).length;
    return (
        <button
            draggable
            onDragStart={(ev) => ev.dataTransfer.setData('text/plain', `item:${item.id}`)}
            onClick={onOpen}
            className="flex w-full flex-col gap-1 text-left"
            title="Click for upload text and checklist · drag to move"
        >
            <span className="flex gap-1.5">
                <Thumb clip={entry.clip} />
                <span className="line-clamp-3 text-[11px] leading-tight font-semibold">{entry.clip.title}</span>
            </span>
            <span className="flex items-center gap-1 text-[10px]">
                {item.posted ? (
                    <span className="flex items-center gap-0.5 text-emerald-300"><CheckCircle2 size={11} /> Posted{typeof item.views === 'number' ? ` · ${item.views.toLocaleString()}` : ''}</span>
                ) : (
                    <span className="text-white/45">{doneCount}/{CHECKS.length} done</span>
                )}
                {warn && <AlertTriangle size={11} className="ml-auto text-amber-300" aria-label="Same moment as another planned clip" />}
            </span>
        </button>
    );
}

function PostingHours({ hours, onChange, big }: { hours: number[]; onChange: (h: number[]) => void; big?: boolean }) {
    return (
        <div className={big ? 'flex flex-col gap-2' : 'border-t border-white/10 p-3'}>
            <p className="mb-2 text-xs font-semibold text-white/70">Posting times (click to turn on or off)</p>
            <div className="flex flex-wrap gap-1">
                {Array.from({ length: 24 }, (_, h) => (
                    <button
                        key={h}
                        onClick={() => onChange(hours.includes(h) ? hours.filter((x) => x !== h) : [...hours, h].sort((a, b) => a - b))}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${hours.includes(h) ? 'bg-accent text-ink' : 'bg-white/[0.05] text-white/50 hover:text-white'}`}
                    >
                        {hourLabel(h)}
                    </button>
                ))}
            </div>
        </div>
    );
}

const GUIDES: { title: string; body: React.ReactNode }[] = [
    {
        title: 'Schedule a Short in YouTube Studio',
        body: (
            <ol className="list-decimal space-y-1 pl-5">
                <li>Export the clip in Clipsmith (vertical 9:16, under 3 minutes).</li>
                <li>Open <b>studio.youtube.com</b> on your computer and click <b>Create → Upload videos</b>.</li>
                <li>Paste the title, then the description + hashtags from the planner (click the clip in the calendar).</li>
                <li>Pick a thumbnail if offered, set <b>Audience</b> (usually “No, it’s not made for kids”), then <b>Next</b> until <b>Visibility</b>.</li>
                <li>Choose <b>Schedule</b>, set the date and time from your plan, and click <b>Schedule</b>.</li>
                <li>Tick <b>Uploaded</b> and <b>Scheduled</b> in the planner. When it goes live, pin a comment and tick <b>Posted</b>.</li>
            </ol>
        )
    },
    {
        title: 'Launch week of a big game (like GTA 6)',
        body: (
            <ul className="list-disc space-y-1 pl-5">
                <li><b>Speed beats polish.</b> Search interest is highest in the first days, so post the same day you play.</li>
                <li>Put the game name <b>first</b> in the title: “GTA 6: the cops did WHAT 💀”. Add it as a hashtag (Clipsmith does this from the Game field).</li>
                <li>Post <b>2–4 Shorts a day</b> while it trends, spread over your posting times.</li>
                <li>Mix types: funny fails, rage, “things you missed”, first reactions. Watch which do best and make more of those.</li>
                <li>Reply to comments in the first hour. It brings people back to the video.</li>
            </ul>
        )
    },
    {
        title: 'Titles, hooks and the first 3 seconds',
        body: (
            <ul className="list-disc space-y-1 pl-5">
                <li>The first 3 seconds decide if people swipe. Start on the action or the funniest line, not on a slow lead-in (trim it in the timeline).</li>
                <li>Use the <b>hook title</b> to say what is about to happen: “He did NOT expect this”.</li>
                <li>Keep titles short and specific. Questions and reactions (“POV:”, “Why did he…”) work well. Clipsmith suggests alternatives in the Post tab of the editor.</li>
                <li>Don’t promise something the clip doesn’t show; viewers leave and the Short stops being pushed.</li>
            </ul>
        )
    },
    {
        title: 'Clipping other streamers safely',
        body: (
            <ul className="list-disc space-y-1 pl-5">
                <li><b>Ask first.</b> Many streamers welcome clippers or run clip programs with rules; others don’t. Without permission a video can be taken down and the channel can get a strike.</li>
                <li>Credit them in the title or description and link their channel.</li>
                <li>Add something of your own: captions, edits, a hook title, commentary. Plain re-uploads are more likely to be treated as reused content.</li>
                <li>Follow their rules on music, sponsors and what can be clipped.</li>
            </ul>
        )
    },
    {
        title: 'Reading your results',
        body: (
            <ul className="list-disc space-y-1 pl-5">
                <li>In YouTube Studio, open a Short → <b>Analytics</b>. “Viewed vs. swiped away” shows if the start works; a low number means the hook needs to be stronger.</li>
                <li>Compare Shorts after the same amount of time (e.g. 24 hours). Type those views into the planner to find your best posting times.</li>
                <li>Change one thing at a time (time, title style, length) so you know what made the difference.</li>
            </ul>
        )
    }
];

function Guides() {
    return (
        <div className="grid gap-3 md:grid-cols-2">
            {GUIDES.map((g, i) => (
                <details key={g.title} className="panel group p-4" open={i < 2}>
                    <summary className="cursor-pointer list-none font-bold">
                        <span className="mr-2 text-accent">▸</span>
                        {g.title}
                    </summary>
                    <div className="mt-3 text-sm leading-relaxed text-white/80">{g.body}</div>
                </details>
            ))}
            <p className="text-xs text-muted md:col-span-2">YouTube changes its menus from time to time; if a button has moved, look for the same words nearby.</p>
        </div>
    );
}
