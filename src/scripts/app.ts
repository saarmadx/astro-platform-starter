import type { Category, Content, MoneyMethod, Progress } from '../lib/types';
import { cleanProgress, emptyProgress, MAX_NOTE } from '../lib/progress';

interface Boot {
    user: { uid: string; name: string };
    content: Content;
}

const boot = JSON.parse(document.getElementById('boot')!.textContent!) as Boot;
const { user, content } = boot;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const regionName = new Map(content.regions.map((r) => [r.id, r.name]));
const allItems = content.categories.flatMap((c) => c.items);
const itemIds = new Set(allItems.map((i) => i.id));

// ---------------------------------------------------------------------------
// Storage + sync
// ---------------------------------------------------------------------------

const LS_KEY = `l100:progress:${user.uid}`;
const LS_DIRTY = `l100:dirty:${user.uid}`;
const LS_PREFS = `l100:prefs:${user.uid}`;

function lsGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}
function lsSet(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* storage full or blocked: cloud sync still works */
    }
}

function loadLocal(): Progress {
    try {
        const raw = lsGet(LS_KEY);
        return raw ? cleanProgress(JSON.parse(raw)) : emptyProgress();
    } catch {
        return emptyProgress();
    }
}

let progress = loadLocal();
let pushTimer: number | undefined;
let pushing = false;

type SyncState = 'idle' | 'saving' | 'synced' | 'offline' | 'error' | 'signedout';
const syncLabels: Record<SyncState, string> = {
    idle: 'Ready',
    saving: 'Saving…',
    synced: 'Synced',
    offline: 'Offline · saved on device',
    error: 'Saved on device · retrying',
    signedout: 'Session ended · sign in again'
};
function setSync(state: SyncState) {
    const el = $('#sync');
    el.dataset.state = state;
    $('span', el).textContent = syncLabels[state];
}

function saveLocal(markDirty: boolean) {
    lsSet(LS_KEY, JSON.stringify(progress));
    if (markDirty) lsSet(LS_DIRTY, '1');
}

function commit() {
    progress.updatedAt = Date.now();
    saveLocal(true);
    schedulePush();
}

function schedulePush(delay = 700) {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(push, delay);
}

async function push() {
    if (pushing) return schedulePush(500);
    if (!navigator.onLine) return setSync('offline');
    pushing = true;
    setSync('saving');
    const sent = progress.updatedAt;
    try {
        const res = await fetch('/api/progress', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(progress),
            credentials: 'same-origin'
        });
        if (res.status === 401) return setSync('signedout');
        if (!res.ok) throw new Error(String(res.status));
        if (progress.updatedAt === sent) lsSet(LS_DIRTY, '');
        setSync('synced');
    } catch {
        setSync(navigator.onLine ? 'error' : 'offline');
        schedulePush(15000);
    } finally {
        pushing = false;
    }
}

async function pull() {
    if (!navigator.onLine) return setSync('offline');
    try {
        const res = await fetch('/api/progress', { credentials: 'same-origin', cache: 'no-store' });
        if (res.status === 401) return setSync('signedout');
        if (!res.ok) throw new Error(String(res.status));
        const server = cleanProgress(await res.json());
        const dirty = lsGet(LS_DIRTY) === '1';
        if (server.updatedAt > progress.updatedAt) {
            progress = server;
            saveLocal(false);
            lsSet(LS_DIRTY, '');
            renderAllState();
            setSync('synced');
        } else if (dirty || progress.updatedAt > server.updatedAt) {
            await push();
        } else {
            setSync('synced');
        }
    } catch {
        setSync('error');
        schedulePush(15000);
    }
}

window.addEventListener('online', () => pull());
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pull();
    // Flush quickly when the user switches away (e.g. back to the game).
    else if (lsGet(LS_DIRTY) === '1') push();
});
// Another tab on this device changed progress.
window.addEventListener('storage', (e) => {
    if (e.key === LS_KEY && e.newValue) {
        progress = loadLocal();
        renderAllState();
    }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function catStats(c: Category) {
    const total = c.items.length;
    const done = c.items.filter((i) => progress.done[i.id]).length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function overall() {
    const total = allItems.length;
    const done = allItems.filter((i) => progress.done[i.id]).length;
    return { total, done, pct: total ? (done / total) * 100 : 0 };
}

const fmtPct = (p: number) => (p > 0 && p < 1 ? '<1' : p === 100 ? '100' : String(Math.floor(p)));

// ---------------------------------------------------------------------------
// Progress tab
// ---------------------------------------------------------------------------

const RING_C = 2 * Math.PI * 86;
const ringArc = $('#ring-arc') as unknown as SVGCircleElement;
ringArc.style.strokeDasharray = String(RING_C);
ringArc.style.strokeDashoffset = String(RING_C);

let shownPct = 0;
function renderProgress() {
    const o = overall();
    requestAnimationFrame(() => {
        ringArc.style.strokeDashoffset = String(RING_C * (1 - o.pct / 100));
    });
    animateNumber(shownPct, o.pct, (v) => ($('#ring-pct').textContent = `${fmtPct(v)}%`));
    shownPct = o.pct;
    $('#ring-count').textContent = `${o.done} of ${o.total} done`;
    $('.ring-card').classList.toggle('complete', o.total > 0 && o.done === o.total);

    $('#cat-bars').innerHTML = content.categories
        .map((c) => {
            const s = catStats(c);
            const soon = c.items.length === 0;
            return `<a class="cat-bar card${soon ? ' soon' : ''}${!soon && s.done === s.total ? ' full' : ''}" href="#checklist" data-jump="${esc(c.id)}">
                <div class="cat-bar-top">
                    <span class="cat-bar-name">${esc(c.name)}</span>
                    ${soon ? '<span class="pill pill-muted">Coming soon</span>' : `<span class="cat-bar-num">${s.done}<small>/${s.total}</small></span>`}
                </div>
                <div class="bar"><i style="width:${s.pct}%"></i></div>
            </a>`;
        })
        .join('');
}

function animateNumber(from: number, to: number, cb: (v: number) => void) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) return cb(to);
    const start = performance.now();
    const dur = 700;
    const step = (t: number) => {
        const k = Math.min(1, (t - start) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        cb(k === 1 ? to : from + (to - from) * e);
        if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

$('#cat-bars').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (!a) return;
    e.preventDefault();
    showTab('checklist');
    jumpToCategory(a.dataset.jump!);
});

// ---------------------------------------------------------------------------
// Checklist tab
// ---------------------------------------------------------------------------

const prefs = (() => {
    try {
        return JSON.parse(lsGet(LS_PREFS) || '{}') as { region?: string; hideDone?: boolean };
    } catch {
        return {};
    }
})();
const q = $<HTMLInputElement>('#q');
const regionSel = $<HTMLSelectElement>('#region');
const hideDone = $<HTMLInputElement>('#hide-done');
if (prefs.region && regionName.has(prefs.region)) regionSel.value = prefs.region;
hideDone.checked = Boolean(prefs.hideDone);

const tickSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2L18.5 7.5"/></svg>';

function itemHtml(c: Category, i: Category['items'][number]) {
    const done = Boolean(progress.done[i.id]);
    const note = progress.notes[i.id] ?? '';
    const reg = i.region ? regionName.get(i.region) : '';
    const cid = `chk-${i.id}`;
    return `<li class="item${done ? ' done' : ''}" data-id="${esc(i.id)}" data-region="${esc(i.region)}" data-cat="${esc(c.id)}">
        <div class="check">
            <input type="checkbox" id="${cid}" ${done ? 'checked' : ''} />
            <span class="box">${tickSvg}</span>
        </div>
        <div class="item-body">
            <div class="item-top">
                <label class="item-name" for="${cid}">${esc(i.name)}</label>
                ${reg ? `<span class="pill">${esc(reg)}</span>` : ''}
            </div>
            ${i.tip ? `<p class="item-tip">${esc(i.tip)}</p>` : ''}
            <p class="item-note"${note ? '' : ' hidden'}>${esc(note)}</p>
            <button type="button" class="note-btn" aria-expanded="false">${note ? 'Edit note' : '+ Note'}</button>
            <div class="note-editor" hidden>
                <textarea class="field" rows="2" maxlength="${MAX_NOTE}" placeholder="Your private note…" aria-label="Note for ${esc(i.name)}">${esc(note)}</textarea>
                <div class="note-actions">
                    <small class="note-saved"></small>
                    <button type="button" class="btn btn-sm note-done">Done</button>
                </div>
            </div>
        </div>
    </li>`;
}

function renderChecklist() {
    $('#cat-chips').innerHTML = content.categories
        .map((c) => `<button type="button" class="chip" data-chip="${esc(c.id)}">${esc(c.name)}</button>`)
        .join('');

    $('#checklist-list').innerHTML =
        content.categories
            .map((c) => {
                const s = catStats(c);
                return `<section class="cat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}">
                <header class="cat-head">
                    <div>
                        <h2>${esc(c.name)}</h2>
                        ${c.blurb ? `<p>${esc(c.blurb)}</p>` : ''}
                    </div>
                    ${c.items.length ? `<span class="cat-count" data-count>${s.done}/${s.total}</span>` : ''}
                </header>
                ${c.items.length ? `<div class="bar"><i data-bar style="width:${s.pct}%"></i></div>` : ''}
                ${
                    c.items.length
                        ? `<ul class="items">${c.items.map((i) => itemHtml(c, i)).join('')}</ul><p class="cat-empty" hidden>Nothing here matches your filters.</p>`
                        : `<p class="coming">Coming soon – being mapped, added in an update.</p>`
                }
            </section>`;
            })
            .join('') + `<p class="no-results" id="no-results" hidden>No items match. Try clearing the search or region filter.</p>`;
    applyFilters();
}

function applyFilters() {
    const term = q.value.trim().toLowerCase();
    const region = regionSel.value;
    const hide = hideDone.checked;
    const filtering = Boolean(term || region || hide);
    let anyVisible = false;

    for (const sec of $$('.cat', $('#checklist-list'))) {
        const items = $$('.item', sec);
        let visible = 0;
        for (const li of items) {
            const id = li.dataset.id!;
            const hay = li.textContent!.toLowerCase();
            const show = (!term || hay.includes(term)) && (!region || li.dataset.region === region) && (!hide || !progress.done[id] || li.classList.contains('leaving'));
            li.hidden = !show;
            if (show) visible++;
        }
        const empty = $('.cat-empty', sec);
        if (empty) empty.hidden = visible > 0 || items.length === 0;
        // When filtering, hide categories with nothing to show so results stay compact.
        sec.hidden = filtering && visible === 0;
        if (!sec.hidden) anyVisible = true;
    }
    $('#no-results').hidden = anyVisible;
    lsSet(LS_PREFS, JSON.stringify({ region, hideDone: hide }));
}

function updateCategoryCounts(catId: string) {
    const c = content.categories.find((x) => x.id === catId);
    const sec = document.getElementById(`cat-${catId}`);
    if (!c || !sec) return;
    const s = catStats(c);
    const count = $('[data-count]', sec);
    if (count) count.textContent = `${s.done}/${s.total}`;
    const bar = $('[data-bar]', sec);
    if (bar) bar.style.width = `${s.pct}%`;
}

function jumpToCategory(id: string) {
    const sec = document.getElementById(`cat-${id}`);
    if (!sec) return;
    if (sec.hidden) {
        q.value = '';
        regionSel.value = '';
        applyFilters();
    }
    requestAnimationFrame(() => {
        const top = sec.getBoundingClientRect().top + scrollY - toolbarOffset();
        scrollTo({ top, behavior: 'smooth' });
    });
}

function toolbarOffset() {
    const header = $('.app-header').getBoundingClientRect().height;
    const tabbar = matchMedia('(min-width: 768px)').matches ? $('.tabbar').getBoundingClientRect().height : 0;
    return header + tabbar + 12;
}

let filterTimer: number | undefined;
q.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilters, 120);
});
regionSel.addEventListener('change', applyFilters);
hideDone.addEventListener('change', applyFilters);
$('#cat-chips').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-chip]');
    if (b) jumpToCategory(b.dataset.chip!);
});

const checklistEl = $('#checklist-list');

checklistEl.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type !== 'checkbox') return;
    const li = input.closest<HTMLElement>('.item')!;
    const id = li.dataset.id!;
    if (input.checked) progress.done[id] = Date.now();
    else delete progress.done[id];
    li.classList.toggle('done', input.checked);
    if (input.checked) {
        li.classList.remove('pop');
        void li.offsetWidth; // restart animation
        li.classList.add('pop');
        if (navigator.vibrate) navigator.vibrate(12);
    }
    commit();
    updateCategoryCounts(li.dataset.cat!);
    renderProgress();
    celebrateIfCategoryDone(li.dataset.cat!, input.checked);

    if (hideDone.checked && input.checked) {
        li.classList.add('leaving');
        setTimeout(() => {
            li.classList.remove('leaving');
            applyFilters();
        }, 650);
    }
});

function celebrateIfCategoryDone(catId: string, justChecked: boolean) {
    if (!justChecked) return;
    const c = content.categories.find((x) => x.id === catId);
    if (!c) return;
    const s = catStats(c);
    if (s.total && s.done === s.total) toast(`${c.name} complete!`);
    const o = overall();
    if (o.total && o.done === o.total) toast('100% complete. Legend.');
}

// Notes
const noteTimers = new Map<string, number>();
checklistEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const li = t.closest<HTMLElement>('.item');
    if (!li) return;
    if (t.closest('.note-btn')) {
        const editor = $('.note-editor', li);
        const open = editor.hidden;
        editor.hidden = !open;
        $('.note-btn', li).setAttribute('aria-expanded', String(open));
        $('.note-btn', li).hidden = open;
        $('.item-note', li).hidden = open || !progress.notes[li.dataset.id!];
        if (open) $<HTMLTextAreaElement>('textarea', li).focus();
    } else if (t.closest('.note-done')) {
        closeNote(li);
    }
});
checklistEl.addEventListener('input', (e) => {
    const ta = e.target as HTMLTextAreaElement;
    if (ta.tagName !== 'TEXTAREA') return;
    const li = ta.closest<HTMLElement>('.item')!;
    const id = li.dataset.id!;
    $('.note-saved', li).textContent = 'Saving…';
    clearTimeout(noteTimers.get(id));
    noteTimers.set(
        id,
        window.setTimeout(() => {
            saveNote(id, ta.value);
            $('.note-saved', li).textContent = 'Saved';
        }, 500)
    );
});

function saveNote(id: string, value: string) {
    const v = value.slice(0, MAX_NOTE);
    if (v.trim()) progress.notes[id] = v;
    else delete progress.notes[id];
    commit();
}

function closeNote(li: HTMLElement) {
    const id = li.dataset.id!;
    const ta = $<HTMLTextAreaElement>('textarea', li);
    clearTimeout(noteTimers.get(id));
    saveNote(id, ta.value);
    const note = progress.notes[id] ?? '';
    $('.note-editor', li).hidden = true;
    const btn = $('.note-btn', li);
    btn.hidden = false;
    btn.textContent = note ? 'Edit note' : '+ Note';
    btn.setAttribute('aria-expanded', 'false');
    const p = $('.item-note', li);
    p.textContent = note;
    p.hidden = !note;
    $('.note-saved', li).textContent = '';
}

// ---------------------------------------------------------------------------
// Money tab
// ---------------------------------------------------------------------------

function moneyCard(m: MoneyMethod) {
    const diff = m.difficulty.toLowerCase();
    return `<article class="card money-card">
        <header>
            <h3>${esc(m.title)}</h3>
            <span class="diff diff-${diff}">${esc(m.difficulty)}</span>
        </header>
        <dl class="money-stats">
            ${m.payout ? `<div><dt>Payout</dt><dd class="payout">${esc(m.payout)}</dd></div>` : ''}
            ${m.time ? `<div><dt>Time</dt><dd>${esc(m.time)}</dd></div>` : ''}
        </dl>
        ${m.unlock ? `<p class="unlock"><span>Unlock</span>${esc(m.unlock)}</p>` : ''}
        ${m.steps.length ? `<ol class="steps">${m.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    </article>`;
}

function renderMoney() {
    $('#money-list').innerHTML = content.money.length
        ? content.money.map(moneyCard).join('')
        : `<div class="card coming-card"><span class="pill pill-warm">Coming soon</span><p>Coming soon – being mapped, added in an update.</p></div>`;
}

// ---------------------------------------------------------------------------
// Settings: backup / restore / reset
// ---------------------------------------------------------------------------

function toB64url(str: string) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string) {
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function backupCode() {
    return 'L100-' + toB64url(JSON.stringify({ v: 1, d: progress.done, n: progress.notes }));
}

function renderBackup() {
    $<HTMLTextAreaElement>('#backup-out').value = backupCode();
}

$('#backup-copy').addEventListener('click', async () => {
    const ta = $<HTMLTextAreaElement>('#backup-out');
    ta.value = backupCode();
    try {
        await navigator.clipboard.writeText(ta.value);
        toast('Backup code copied');
    } catch {
        ta.focus();
        ta.select();
        toast('Select the code and copy it');
    }
});

$('#restore-btn').addEventListener('click', () => {
    const raw = $<HTMLTextAreaElement>('#restore-in').value.trim().replace(/\s+/g, '');
    const msg = $('#restore-msg');
    msg.className = 'form-msg';
    try {
        if (!raw.startsWith('L100-')) throw new Error();
        const data = JSON.parse(fromB64url(raw.slice(5)));
        const restored = cleanProgress({ done: data.d, notes: data.n, updatedAt: Date.now() });
        progress = restored;
        commit();
        renderAllState();
        $<HTMLTextAreaElement>('#restore-in').value = '';
        const count = Object.keys(restored.done).filter((id) => itemIds.has(id)).length;
        msg.textContent = `Restored. ${count} item${count === 1 ? '' : 's'} ticked.`;
        msg.classList.add('ok');
    } catch {
        msg.textContent = "That code doesn't look right. Check you copied all of it.";
        msg.classList.add('bad');
    }
});

const step1 = $('#reset-step1');
const step2 = $('#reset-step2');
$('#reset-start').addEventListener('click', () => {
    const done = Object.keys(progress.done).length;
    const notes = Object.keys(progress.notes).length;
    $('#reset-summary').textContent = `This clears ${done} ticked item${done === 1 ? '' : 's'} and ${notes} note${notes === 1 ? '' : 's'}.`;
    step1.hidden = true;
    step2.hidden = false;
    $('#reset-cancel').focus();
});
$('#reset-cancel').addEventListener('click', () => {
    step2.hidden = true;
    step1.hidden = false;
});
$('#reset-confirm').addEventListener('click', () => {
    progress = emptyProgress();
    commit();
    renderAllState();
    step2.hidden = true;
    step1.hidden = false;
    toast('Progress reset');
});

// Sign out: wipe this device's copy so the next person on a shared device starts clean.
$('#logout-form').addEventListener('submit', () => {
    try {
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem(LS_DIRTY);
        localStorage.removeItem(LS_PREFS);
    } catch {
        /* ignore */
    }
    navigator.serviceWorker?.controller?.postMessage('clear');
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = ['progress', 'checklist', 'money', 'guide', 'settings'];
function showTab(id: string, scroll = true) {
    if (!TABS.includes(id)) id = 'progress';
    for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== id;
    for (const t of $$('[data-tab]')) {
        const on = t.dataset.tab === id;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
    }
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    if (id === 'settings') renderBackup();
    if (scroll) scrollTo({ top: 0 });
}
$('.tabbar').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.tab!);
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;
function toast(text: string) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderAllState() {
    renderProgress();
    renderChecklist();
    if (!$('#panel-settings').hidden) renderBackup();
}

renderMoney();
renderAllState();
showTab(location.hash.slice(1) || 'progress', false);
pull();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
