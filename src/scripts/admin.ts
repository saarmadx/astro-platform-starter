import type { Category, Content, Guide, MoneyMethod } from '../lib/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let data: Content;
let source: 'admin' | 'files' = 'files';
let section = 'checklist';
let dirty = false;
const openCats = new Set<string>();

// ---------- helpers ----------

function slugify(s: string) {
    return (
        s
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'item'
    );
}

function uniqueId(base: string, taken: Set<string>) {
    let id = slugify(base);
    let n = 2;
    while (taken.has(id)) id = `${slugify(base).slice(0, 55)}-${n++}`;
    return id;
}

const allItemIds = () => new Set(data.categories.flatMap((c) => c.items.map((i) => i.id)));

function setDirty(v: boolean) {
    dirty = v;
    $('#dirty').hidden = !v;
    $<HTMLButtonElement>('#save').disabled = !v;
}

function message(text: string, kind: 'ok' | 'bad' | '' = '') {
    const el = $('#msg');
    el.textContent = text;
    el.className = `adm-msg ${kind}`;
}

function banner() {
    $('#banner').innerHTML =
        source === 'admin'
            ? `<strong>Live:</strong> content saved from this admin page. The JSON files in <code>src/content</code> are only used if you discard admin edits.`
            : `<strong>Live:</strong> the JSON files in <code>src/content</code>. Saving here publishes your edits instantly, with no redeploy.`;
}

window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
});

// Two-step delete: first click arms, second click (within 4s) confirms. No browser popups.
function armOrRun(btn: HTMLElement, run: () => void) {
    if (btn.dataset.armed === '1') {
        run();
        return;
    }
    btn.dataset.armed = '1';
    const label = btn.textContent;
    btn.textContent = 'Click again to confirm';
    btn.classList.add('armed');
    setTimeout(() => {
        if (!btn.isConnected) return;
        btn.dataset.armed = '';
        btn.textContent = label;
        btn.classList.remove('armed');
    }, 4000);
}

// ---------- render ----------

function regionOptions(selected: string) {
    return `<option value="">No region</option>${data.regions.map((r) => `<option value="${esc(r.id)}"${r.id === selected ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}`;
}

function renderChecklist() {
    return `
    <div class="adm-section-head">
        <div><h2>Checklist</h2><p class="adm-hint">Categories with no items show "Coming soon" in the app. IDs are permanent: they link to members' saved progress.</p></div>
    </div>
    ${data.categories
        .map(
            (c, ci) => `
        <details class="card adm-cat" data-cat="${ci}" ${openCats.has(c.id) ? 'open' : ''}>
            <summary>
                <span class="adm-cat-name">${esc(c.name)}</span>
                <span class="pill ${c.items.length ? '' : 'pill-muted'}">${c.items.length ? `${c.items.length} item${c.items.length === 1 ? '' : 's'}` : 'Coming soon'}</span>
            </summary>
            <div class="adm-grid2">
                <div><label class="lbl">Category name</label><input class="field" data-bind="categories.${ci}.name" value="${esc(c.name)}" /></div>
                <div><label class="lbl">Short description</label><input class="field" data-bind="categories.${ci}.blurb" value="${esc(c.blurb)}" /></div>
            </div>
            <p class="adm-id">ID: <code>${esc(c.id)}</code></p>

            <div class="adm-items">
                ${c.items
                    .map(
                        (it, ii) => `
                <div class="adm-item">
                    <div class="adm-grid3">
                        <div><label class="lbl">Item name</label><input class="field" data-bind="categories.${ci}.items.${ii}.name" value="${esc(it.name)}" /></div>
                        <div><label class="lbl">Region</label><select class="field" data-bind="categories.${ci}.items.${ii}.region">${regionOptions(it.region)}</select></div>
                        <div class="adm-item-actions">
                            <button type="button" class="btn btn-sm btn-ghost" data-act="item-up" data-ci="${ci}" data-ii="${ii}" ${ii === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                            <button type="button" class="btn btn-sm btn-ghost" data-act="item-down" data-ci="${ci}" data-ii="${ii}" ${ii === c.items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                            <button type="button" class="btn btn-sm btn-danger" data-act="item-del" data-ci="${ci}" data-ii="${ii}">Delete</button>
                        </div>
                    </div>
                    <label class="lbl">Tip</label>
                    <input class="field" data-bind="categories.${ci}.items.${ii}.tip" value="${esc(it.tip)}" />
                    <p class="adm-id">ID: <code>${esc(it.id)}</code></p>
                </div>`
                    )
                    .join('')}
            </div>

            <form class="adm-add" data-add-item="${ci}">
                <h4>Add item</h4>
                <div class="adm-grid3">
                    <div><label class="lbl">Name</label><input class="field" name="name" required /></div>
                    <div><label class="lbl">Region</label><select class="field" name="region">${regionOptions('')}</select></div>
                    <div><label class="lbl">Tip</label><input class="field" name="tip" /></div>
                </div>
                <button class="btn btn-sm" type="submit">+ Add item</button>
            </form>

            <div class="adm-cat-actions">
                <button type="button" class="btn btn-sm btn-ghost" data-act="cat-up" data-ci="${ci}" ${ci === 0 ? 'disabled' : ''}>Move category up</button>
                <button type="button" class="btn btn-sm btn-ghost" data-act="cat-down" data-ci="${ci}" ${ci === data.categories.length - 1 ? 'disabled' : ''}>Move category down</button>
                <button type="button" class="btn btn-sm btn-danger" data-act="cat-del" data-ci="${ci}">Delete category</button>
            </div>
        </details>`
        )
        .join('')}
    <form class="card adm-add" data-add-cat>
        <h4>Add category</h4>
        <div class="adm-grid2">
            <div><label class="lbl">Name</label><input class="field" name="name" required /></div>
            <div><label class="lbl">Short description</label><input class="field" name="blurb" /></div>
        </div>
        <button class="btn btn-sm" type="submit">+ Add category</button>
    </form>`;
}

function renderMoney() {
    const diffOpts = (d: string) => ['Easy', 'Medium', 'Hard'].map((x) => `<option${x === d ? ' selected' : ''}>${x}</option>`).join('');
    return `
    <div class="adm-section-head"><div><h2>Money methods</h2><p class="adm-hint">With no methods, the app shows "Coming soon". Steps: one per line.</p></div></div>
    ${data.money
        .map(
            (m, mi) => `
        <div class="card adm-block">
            <div class="adm-grid2">
                <div><label class="lbl">Title</label><input class="field" data-bind="money.${mi}.title" value="${esc(m.title)}" /></div>
                <div><label class="lbl">Payout</label><input class="field" data-bind="money.${mi}.payout" value="${esc(m.payout)}" placeholder="e.g. $50,000" /></div>
                <div><label class="lbl">Time</label><input class="field" data-bind="money.${mi}.time" value="${esc(m.time)}" placeholder="e.g. 15 min" /></div>
                <div><label class="lbl">Difficulty</label><select class="field" data-bind="money.${mi}.difficulty">${diffOpts(m.difficulty)}</select></div>
            </div>
            <label class="lbl">Unlock requirement</label>
            <input class="field" data-bind="money.${mi}.unlock" value="${esc(m.unlock)}" />
            <label class="lbl">Steps (one per line)</label>
            <textarea class="field" rows="5" data-bind="money.${mi}.steps" data-lines>${esc(m.steps.join('\n'))}</textarea>
            <div class="adm-row-end">
                <span class="adm-id">ID: <code>${esc(m.id)}</code></span>
                <button type="button" class="btn btn-sm btn-danger" data-act="money-del" data-mi="${mi}">Delete</button>
            </div>
        </div>`
        )
        .join('')}
    <form class="card adm-add" data-add-money>
        <h4>Add money method</h4>
        <div class="adm-grid2">
            <div><label class="lbl">Title</label><input class="field" name="title" required /></div>
            <div><label class="lbl">Difficulty</label><select class="field" name="difficulty">${diffOpts('Easy')}</select></div>
        </div>
        <button class="btn btn-sm" type="submit">+ Add method</button>
    </form>`;
}

function renderGuides() {
    return `
    <div class="adm-section-head"><div><h2>Guide pages</h2><p class="adm-hint">Body uses Markdown: <code>## Heading</code>, <code>**bold**</code>, <code>- list item</code>.</p></div></div>
    ${data.guides
        .map(
            (g, gi) => `
        <div class="card adm-block">
            <div class="adm-grid2">
                <div><label class="lbl">Title</label><input class="field" data-bind="guides.${gi}.title" value="${esc(g.title)}" /></div>
                <div><label class="lbl">Last updated</label><input class="field" data-bind="guides.${gi}.updated" value="${esc(g.updated)}" placeholder="YYYY-MM-DD" /></div>
            </div>
            <label class="lbl">Summary</label>
            <input class="field" data-bind="guides.${gi}.summary" value="${esc(g.summary)}" />
            <label class="lbl">Body (Markdown)</label>
            <textarea class="field mono" rows="12" data-bind="guides.${gi}.body">${esc(g.body)}</textarea>
            <div class="adm-row-end">
                <span class="adm-id">URL: <code>/app/guide/${esc(g.slug)}</code></span>
                <div class="adm-inline">
                    <button type="button" class="btn btn-sm btn-ghost" data-act="guide-up" data-gi="${gi}" ${gi === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-act="guide-down" data-gi="${gi}" ${gi === data.guides.length - 1 ? 'disabled' : ''}>↓</button>
                    <button type="button" class="btn btn-sm btn-danger" data-act="guide-del" data-gi="${gi}">Delete</button>
                </div>
            </div>
        </div>`
        )
        .join('')}
    <form class="card adm-add" data-add-guide>
        <h4>Add guide page</h4>
        <label class="lbl">Title</label><input class="field" name="title" required />
        <button class="btn btn-sm" type="submit">+ Add page</button>
    </form>`;
}

function renderRegions() {
    const used = new Map<string, number>();
    data.categories.forEach((c) => c.items.forEach((i) => i.region && used.set(i.region, (used.get(i.region) ?? 0) + 1)));
    return `
    <div class="adm-section-head"><div><h2>Regions</h2><p class="adm-hint">Used for item tags and the region filter. A region can only be deleted when no items use it.</p></div></div>
    <div class="card">
    ${data.regions
        .map(
            (r, ri) => `
        <div class="adm-region">
            <input class="field" data-bind="regions.${ri}.name" value="${esc(r.name)}" aria-label="Region name" />
            <span class="adm-id"><code>${esc(r.id)}</code> · ${used.get(r.id) ?? 0} items</span>
            <button type="button" class="btn btn-sm btn-danger" data-act="region-del" data-ri="${ri}" ${used.get(r.id) ? 'disabled title="Remove it from items first"' : ''}>Delete</button>
        </div>`
        )
        .join('')}
    </div>
    <form class="card adm-add" data-add-region>
        <h4>Add region</h4>
        <label class="lbl">Name</label><input class="field" name="name" required />
        <button class="btn btn-sm" type="submit">+ Add region</button>
    </form>`;
}

function renderData() {
    return `
    <div class="adm-section-head"><div><h2>Backup &amp; files</h2></div></div>
    <div class="card adm-block">
        <h4>Download as JSON files</h4>
        <p class="adm-hint">Download the current content as the four files in <code>src/content</code>. Commit them to your repo to make these edits the permanent defaults.</p>
        <div class="adm-inline">
            <button type="button" class="btn btn-sm" data-dl="regions">regions.json</button>
            <button type="button" class="btn btn-sm" data-dl="checklist">checklist.json</button>
            <button type="button" class="btn btn-sm" data-dl="money">money.json</button>
            <button type="button" class="btn btn-sm" data-dl="guides">guides.json</button>
        </div>
    </div>
    <div class="card adm-block">
        <h4>Discard admin edits</h4>
        <p class="adm-hint">Go back to the JSON files that shipped with the last deploy. Members' progress isn't affected.</p>
        <button type="button" class="btn btn-sm btn-danger" data-act="reset-content" ${source === 'files' ? 'disabled' : ''}>Use the JSON files again</button>
    </div>`;
}

function render() {
    const views: Record<string, () => string> = { checklist: renderChecklist, money: renderMoney, guides: renderGuides, regions: renderRegions, data: renderData };
    $('#editor').innerHTML = views[section]();
    for (const b of $$('[data-section]')) b.classList.toggle('active', b.dataset.section === section);
}

// ---------- events ----------

function setPath(path: string, value: unknown) {
    const parts = path.split('.');
    let o: any = data;
    for (const p of parts.slice(0, -1)) o = o[p];
    o[parts.at(-1)!] = value;
}

document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const path = el.dataset?.bind;
    if (!path) return;
    setPath(path, 'lines' in el.dataset ? el.value.split('\n') : el.value);
    setDirty(true);
});
document.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.tagName === 'SELECT' && el.dataset.bind) {
        setPath(el.dataset.bind, el.value);
        setDirty(true);
    }
});
// Remember which categories are expanded across re-renders.
document.addEventListener(
    'toggle',
    (e) => {
        const d = e.target as HTMLDetailsElement;
        if (!d.classList?.contains('adm-cat')) return;
        const c = data.categories[Number(d.dataset.cat)];
        if (!c) return;
        if (d.open) openCats.add(c.id);
        else openCats.delete(c.id);
    },
    true
);

function move<T>(arr: T[], i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
}

document.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const sec = t.closest<HTMLElement>('[data-section]');
    if (sec) {
        section = sec.dataset.section!;
        render();
        return;
    }

    const dl = t.closest<HTMLElement>('[data-dl]');
    if (dl) {
        const key = dl.dataset.dl!;
        const payload = key === 'checklist' ? data.categories : (data as any)[key];
        const blob = new Blob([JSON.stringify(payload, null, 4) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${key}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        return;
    }

    const btn = t.closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const { act } = btn.dataset;
    const ci = Number(btn.dataset.ci);
    const ii = Number(btn.dataset.ii);
    const changed = () => {
        setDirty(true);
        render();
    };

    switch (act) {
        case 'item-up':
            return (move(data.categories[ci].items, ii, -1), changed());
        case 'item-down':
            return (move(data.categories[ci].items, ii, 1), changed());
        case 'item-del':
            return armOrRun(btn, () => (data.categories[ci].items.splice(ii, 1), changed()));
        case 'cat-up':
            return (move(data.categories, ci, -1), changed());
        case 'cat-down':
            return (move(data.categories, ci, 1), changed());
        case 'cat-del':
            return armOrRun(btn, () => (data.categories.splice(ci, 1), changed()));
        case 'money-del':
            return armOrRun(btn, () => (data.money.splice(Number(btn.dataset.mi), 1), changed()));
        case 'guide-up':
            return (move(data.guides, Number(btn.dataset.gi), -1), changed());
        case 'guide-down':
            return (move(data.guides, Number(btn.dataset.gi), 1), changed());
        case 'guide-del':
            return armOrRun(btn, () => (data.guides.splice(Number(btn.dataset.gi), 1), changed()));
        case 'region-del':
            return armOrRun(btn, () => (data.regions.splice(Number(btn.dataset.ri), 1), changed()));
        case 'reset-content':
            return armOrRun(btn, async () => {
                const res = await fetch('/api/admin/content', { method: 'DELETE' });
                if (!res.ok) return message('Could not discard admin edits.', 'bad');
                const body = await res.json();
                data = body.content;
                source = body.source;
                setDirty(false);
                banner();
                render();
                message('Now using the JSON files again.', 'ok');
            });
    }
});

document.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (!form.closest('#editor')) return;
    e.preventDefault();
    const f = new FormData(form);
    const val = (k: string) => String(f.get(k) ?? '').trim();

    if (form.dataset.addItem !== undefined) {
        const c = data.categories[Number(form.dataset.addItem)];
        c.items.push({ id: uniqueId(val('name'), allItemIds()), name: val('name'), region: val('region'), tip: val('tip') });
        openCats.add(c.id);
    } else if (form.dataset.addCat !== undefined) {
        const id = uniqueId(val('name'), new Set(data.categories.map((c) => c.id)));
        data.categories.push({ id, name: val('name'), blurb: val('blurb'), items: [] } as Category);
        openCats.add(id);
    } else if (form.dataset.addMoney !== undefined) {
        data.money.push({
            id: uniqueId(val('title'), new Set(data.money.map((m) => m.id))),
            title: val('title'),
            payout: '',
            time: '',
            difficulty: val('difficulty') as MoneyMethod['difficulty'],
            unlock: '',
            steps: []
        });
    } else if (form.dataset.addGuide !== undefined) {
        data.guides.push({
            slug: uniqueId(val('title'), new Set(data.guides.map((g) => g.slug))),
            title: val('title'),
            summary: '',
            updated: new Date().toISOString().slice(0, 10),
            body: ''
        } as Guide);
    } else if (form.dataset.addRegion !== undefined) {
        data.regions.push({ id: uniqueId(val('name'), new Set(data.regions.map((r) => r.id))), name: val('name') });
    } else return;

    setDirty(true);
    render();
    message('Added. Remember to Save & publish.', '');
});

$('#save').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    // Steps: drop blank lines before saving.
    data.money.forEach((m) => (m.steps = m.steps.map((s) => s.trim()).filter(Boolean)));
    try {
        const res = await fetch('/api/admin/content', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) {
            message('Your admin session expired. Log in again in another tab, then save.', 'bad');
            btn.disabled = false;
            return;
        }
        if (!res.ok) {
            message(`Not saved: ${body.error ?? `error ${res.status}`}`, 'bad');
            btn.disabled = false;
            return;
        }
        data = body.content;
        source = body.source;
        setDirty(false);
        banner();
        render();
        message('Saved. Members see the changes next time they open or refresh the app.', 'ok');
    } catch {
        message('Network error. Nothing was saved.', 'bad');
        btn.disabled = false;
    } finally {
        btn.textContent = 'Save & publish';
    }
});

// ---------- boot ----------

(async () => {
    const res = await fetch('/api/admin/content', { cache: 'no-store' });
    if (!res.ok) {
        $('#banner').textContent = 'Could not load content. Try logging in again.';
        return;
    }
    const body = await res.json();
    data = body.content;
    source = body.source;
    banner();
    render();
})();
