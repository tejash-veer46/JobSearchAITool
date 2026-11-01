// JobApplyAI dashboard. Plain JS, no build step. All data comes from the local API.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-jobapplyai': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = { view: 'ready', q: '', jobs: [], selected: null, job: null, pollTimer: null, drafts: {} };

const scoreClass = (s) => (s == null ? 'lo' : s >= 75 ? 'hi' : s >= 60 ? 'mid' : 'lo');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const ACTIVE = ['starting', 'filling', 'needs_input', 'ready', 'captcha', 'submitting'];

function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--panel)', padding: '8px 14px', borderRadius: '8px', zIndex: 10, maxWidth: '90vw' });
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------------------------------------------------------------- summary + list

async function loadSummary() {
  const s = await api('/api/summary');
  $('#pills').innerHTML = [
    ['Ready', s.counts.STAGED],
    ['Near misses', s.near],
    ['Applied', s.counts.APPLIED],
    ['Scoring', s.scorer],
  ]
    .map(([k, v]) => `<span class="pill">${esc(k)} <b>${esc(v)}</b></span>`)
    .join('');
  $('#lastRun').textContent = s.lastRun ? `Last fetch ${new Date(s.lastRun.startedAt).toLocaleString()}` : 'No fetch yet';
  const gaps = [];
  if (s.profileGaps.length) gaps.push(`Missing in config/profile.yaml: ${s.profileGaps.join(', ')}. Forms asking for these will wait for you.`);
  if (!s.adzuna) gaps.push('Add a free Adzuna key to .env for India-wide on-site jobs.');
  $('#gapBanner').classList.toggle('hidden', !gaps.length);
  $('#gapBanner').textContent = gaps.join(' ');
}

let listRequest = 0;
async function loadList() {
  const mine = ++listRequest;
  const params = new URLSearchParams({ view: state.view, q: state.q });
  const jobs = await api(`/api/jobs?${params}`);
  if (mine !== listRequest) return; // a newer tab/search request is in flight; ignore this stale one
  state.jobs = jobs;
  renderList();
}

function renderList() {
  const list = $('#list');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty">No jobs here.</div>';
    return;
  }
  list.innerHTML = state.jobs
    .map(
      (j) => `<button class="item ${j.id === state.selected ? 'selected' : ''}" data-id="${j.id}">
        <span class="t">${esc(j.title)}</span>
        <span class="score ${scoreClass(j.match_score)}">${j.match_score ?? '–'}</span>
        <span class="c">${esc(j.company)} · ${esc(j.location)} · ${day(j.applied_at ?? j.posted_at)}</span>
      </button>`,
    )
    .join('');
}

// ---------------------------------------------------------------- job detail

async function selectJob(id) {
  state.selected = id;
  state.drafts = {};
  renderList();
  state.job = await api(`/api/jobs/${id}`);
  renderDetail();
  if (state.job.session && ACTIVE.includes(state.job.session.state)) startPolling();
}

function renderDetail() {
  const j = state.job;
  if (!j) return;
  const applied = j.status === 'APPLIED';
  const s = j.session;
  const busy = s && ACTIVE.includes(s.state);
  $('#detail').innerHTML = `
    <h2>${esc(j.title)}</h2>
    <div class="meta">${esc(j.company)} · ${esc(j.location)}${j.workplace && !j.location.toLowerCase().includes(j.workplace) ? ` (${esc(j.workplace)})` : ''} ·${esc(j.platform)} · posted ${day(j.posted_at ?? j.first_seen_at)}</div>
    <div class="row">
      <span class="score ${scoreClass(j.match_score)}" style="font-size:14px">${j.match_score ?? '–'}</span>
      <span>${esc(j.match_reason ?? j.reject_reason ?? 'Not scored yet')}</span>
    </div>
    ${j.status === 'REJECTED' ? `<div class="note" style="margin-top:6px">${j.reject_stage === 'score' ? 'Below the score threshold (near miss). Use "Move to ready" if you want to apply anyway.' : `Rejected: ${esc(j.reject_reason ?? '')}`}</div>` : ''}
    ${applied ? `<div class="chip good" style="display:inline-block;margin-top:10px">Applied ${day(j.applied_at)}</div>` : ''}

    <div class="row section">
      <button class="btn primary" data-act="apply" ${busy || applied ? 'disabled' : ''}>Start apply assistant</button>
      <button class="btn" data-act="dry" ${busy ? 'disabled' : ''}>Dry run</button>
      <a class="btn" href="${esc(j.apply_url ?? j.url)}" target="_blank" rel="noopener">Open posting ↗</a>
      ${applied ? '' : '<button class="btn" data-act="applied">Mark applied</button>'}
      ${j.status === 'REJECTED' ? '<button class="btn" data-act="restore">Move to ready</button>' : '<button class="btn danger" data-act="reject">Not interested</button>'}
    </div>
    ${!j.supported ? '<div class="note" style="margin-top:6px">This site is not Greenhouse or Lever, so filling is best-effort: open the application form in the assistant window and press Rescan.</div>' : ''}

    <div id="applyPanel">${s ? applyPanel(s) : ''}</div>

    <div class="section">
      <h3>Skills</h3>
      <div class="chips">
        ${j.matched_skills.map((x) => `<span class="chip good">${esc(x)}</span>`).join('')}
        ${j.missing_skills.map((x) => `<span class="chip bad" title="Asked for, not on your resume">${esc(x)}</span>`).join('')}
        ${!j.matched_skills.length && !j.missing_skills.length ? '<span class="muted">Not scored yet</span>' : ''}
      </div>
    </div>

    <div class="section">
      <h3>Cover note</h3>
      <textarea id="pitch">${esc(j.short_pitch ?? '')}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn" data-act="savePitch">Save note</button><span class="note">Used for "cover letter" and "why us" questions.</span></div>
    </div>

    ${j.tailored_answers.length ? `<div class="section"><h3>Screening answers</h3><table class="answers">${j.tailored_answers
      .map((a) => `<tr><td class="muted" style="padding:3px 12px 3px 0">${esc(a.question)}</td><td>${a.answer === 'ASK_USER' ? '<span class="chip bad">you need to answer</span>' : esc(a.answer)}</td></tr>`)
      .join('')}</table></div>` : ''}

    <div class="section">
      <h3>Notes</h3>
      <textarea id="notes" placeholder="Referral, recruiter name, follow-up date...">${esc(j.notes ?? '')}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn" data-act="saveNotes">Save notes</button></div>
    </div>

    ${j.attempts.length ? `<div class="section"><h3>Apply history</h3>${j.attempts
      .map((a) => `<div class="note">${new Date(a.started_at).toLocaleString()}: ${esc(a.outcome ?? 'in progress')}</div>`)
      .join('')}</div>` : ''}

    <div class="section"><h3>Description</h3><div class="desc">${esc(j.description)}</div></div>
  `;
}

const STATE_LABEL = {
  starting: 'Opening the form',
  filling: 'Filling the form',
  needs_input: 'Needs your answers',
  ready: 'Filled: review the browser window',
  captcha: 'Paused: solve the check in the browser window',
  submitting: 'Submitting',
  submitted: 'Submitted',
  failed: 'Something went wrong',
  closed: 'Closed',
};

function fieldInput(f) {
  const draft = state.drafts[f.key];
  const value = draft ?? (f.kind === 'file' ? '' : (f.value ?? ''));
  if (f.kind === 'file') return `<span>${esc(f.value ?? 'No file')}</span>`;
  if (f.options.length) {
    return `<select class="field-input" data-key="${f.key}"><option value="">Choose…</option>${f.options
      .map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`)
      .join('')}</select>`;
  }
  if (f.kind === 'textarea') return `<textarea class="field-input" data-key="${f.key}">${esc(value)}</textarea>`;
  return `<input class="field-input" data-key="${f.key}" value="${esc(value)}" />`;
}

function applyPanel(s) {
  const open = ACTIVE.includes(s.state);
  const rows = s.fields
    .map(
      (f) => `<tr>
        <td class="lbl"><span class="status-dot ${f.status} ${f.required ? 'required' : ''}"></span>${esc(f.label || '(no label)')}${f.required ? ' <span class="req">*</span>' : ''}
          ${f.note ? `<div class="note">${esc(f.note)}</div>` : ''}${f.error ? `<div class="err">${esc(f.error)}</div>` : ''}</td>
        <td>${fieldInput(f)}
          ${open && f.kind !== 'file' ? `<div class="row" style="margin-top:4px"><button class="btn" data-fill="${f.key}">Fill</button><label class="note"><input type="checkbox" data-remember="${f.key}" /> remember</label></div>` : ''}</td>
        <td class="src"><span class="chip">${esc(f.source ?? '—')}</span></td>
      </tr>`,
    )
    .join('');
  const canSubmit = s.state === 'ready' && !s.dryRun;
  return `<div class="apply">
    <div class="apply-state ${s.state}">${esc(STATE_LABEL[s.state] ?? s.state)}${s.dryRun ? ' · dry run' : ''}</div>
    <div class="apply-body">
      <div>${esc(s.message)}</div>
      ${s.fields.length ? `<table>${rows}</table>` : ''}
      <details style="margin-top:10px"><summary class="note">Activity</summary><pre class="log">${esc(s.log.join('\n'))}</pre></details>
    </div>
    ${open && s.prefill ? `<div class="apply-actions">
      <button class="btn primary" data-act="focus">Go to tab</button>
      <button class="btn" data-act="rescan">Rescan page</button>
      <button class="btn" data-act="done">I submitted it</button>
      <button class="btn ghost" data-act="skip">Skip this job</button>
    </div>` : open ? `<div class="apply-actions">
      <button class="btn" data-act="rescan">Rescan page</button>
      ${s.dryRun ? '' : `<button class="btn primary" data-act="submit" ${canSubmit ? '' : 'disabled'} title="${canSubmit ? '' : 'Fill all required fields first'}">Submit application</button>`}
      ${s.dryRun ? '' : '<button class="btn" data-act="done">I submitted it myself</button>'}
      <button class="btn ghost" data-act="close">Close tab</button>
    </div>` : ''}
  </div>`;
}

function renderApply(s) {
  state.job.session = s;
  const panel = $('#applyPanel');
  // Don't wipe a field the user is typing in.
  const focused = document.activeElement?.dataset?.key;
  if (focused) return;
  panel.innerHTML = applyPanel(s);
}

function startPolling() {
  stopPolling();
  const id = state.selected;
  state.pollTimer = setInterval(async () => {
    if (state.selected !== id) return stopPolling();
    try {
      const s = await api(`/api/jobs/${id}/apply`);
      renderApply(s);
      if (!ACTIVE.includes(s.state)) {
        stopPolling();
        await refreshAll(false);
      }
    } catch {
      stopPolling();
    }
  }, 1000);
}
const stopPolling = () => clearInterval(state.pollTimer);

async function refreshAll(reselect = true) {
  await Promise.all([loadSummary(), loadList()]);
  if (reselect && state.selected) await selectJob(state.selected);
  else if (state.selected) {
    state.job = await api(`/api/jobs/${state.selected}`);
    renderDetail();
  }
}

// ---------------------------------------------------------------- actions

async function act(name, el) {
  const j = state.job;
  const id = j?.id;
  try {
    switch (name) {
      case 'apply':
      case 'dry': {
        const s = await api(`/api/jobs/${id}/apply`, { method: 'POST', body: { dryRun: name === 'dry' } });
        state.job.session = s;
        renderDetail();
        startPolling();
        toast('Opening the form in the assistant browser window…');
        break;
      }
      case 'applied':
        await api(`/api/jobs/${id}`, { method: 'PATCH', body: { status: 'APPLIED' } });
        await refreshAll();
        break;
      case 'reject':
        await api(`/api/jobs/${id}`, { method: 'PATCH', body: { status: 'REJECTED' } });
        await refreshAll();
        break;
      case 'restore':
        await api(`/api/jobs/${id}`, { method: 'PATCH', body: { status: 'STAGED' } });
        await refreshAll();
        break;
      case 'savePitch':
        await api(`/api/jobs/${id}`, { method: 'PATCH', body: { short_pitch: $('#pitch').value } });
        toast('Cover note saved');
        break;
      case 'saveNotes':
        await api(`/api/jobs/${id}`, { method: 'PATCH', body: { notes: $('#notes').value } });
        toast('Notes saved');
        break;
      case 'rescan':
        renderApply(await api(`/api/jobs/${id}/apply/rescan`, { method: 'POST' }));
        startPolling();
        break;
      case 'submit': {
        const ok = confirm(`Submit your application to ${j.company} for "${j.title}"?\n\nThis sends it to the employer. Check every field in the browser window first.`);
        if (!ok) return;
        renderApply(await api(`/api/jobs/${id}/apply/submit`, { method: 'POST', body: { confirm: true } }));
        startPolling();
        break;
      }
      case 'done':
        if (!confirm('Mark this job as applied? Only do this if you submitted the form in the browser window.')) return;
        renderApply(await api(`/api/jobs/${id}/apply/done`, { method: 'POST' }));
        await refreshAll(false);
        break;
      case 'close':
        renderApply(await api(`/api/jobs/${id}/apply/close`, { method: 'POST' }));
        stopPolling();
        break;
      case 'focus':
        await api(`/api/jobs/${id}/apply/focus`, { method: 'POST' });
        toast('Switched to its tab in the assistant window');
        break;
      case 'skip':
        renderApply(await api(`/api/jobs/${id}/apply/skip`, { method: 'POST' }));
        stopPolling();
        break;
    }
  } catch (err) {
    toast(err.message);
  }
  void el;
}

async function fillOne(key) {
  const input = document.querySelector(`[data-key="${key}"]`);
  const remember = document.querySelector(`[data-remember="${key}"]`)?.checked ?? false;
  if (!input?.value) return toast('Enter a value first');
  try {
    delete state.drafts[key];
    input.blur();
    renderApply(await api(`/api/jobs/${state.selected}/apply/answer`, { method: 'POST', body: { key, value: input.value, remember } }));
    if (remember) toast('Saved for future forms');
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- fetch new jobs

async function runFetch() {
  const dialog = $('#runDialog');
  try {
    await api('/api/run', { method: 'POST' });
  } catch (err) {
    if (!/already running/.test(err.message)) return toast(err.message);
  }
  dialog.showModal();
  $('#runBtn').disabled = true;
  const timer = setInterval(async () => {
    const r = await api('/api/run');
    $('#runLog').textContent = r.log.join('\n') + (r.error ? `\nError: ${r.error}` : '');
    $('#runLog').scrollTop = $('#runLog').scrollHeight;
    if (!r.running) {
      clearInterval(timer);
      $('#runBtn').disabled = false;
      await refreshAll(false);
    }
  }, 1000);
}

// ---------------------------------------------------------------- wiring

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  state.view = tab.dataset.view;
  void loadList();
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value;
    void loadList();
  }, 200);
});

$('#list').addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (item) void selectJob(Number(item.dataset.id));
});

$('#detail').addEventListener('click', (e) => {
  const fill = e.target.closest('[data-fill]');
  if (fill) return void fillOne(fill.dataset.fill);
  const btn = e.target.closest('[data-act]');
  if (btn) void act(btn.dataset.act, btn);
});

$('#detail').addEventListener('input', (e) => {
  const key = e.target.dataset?.key;
  if (key) state.drafts[key] = e.target.value;
});
$('#detail').addEventListener('focusout', (e) => {
  // Let the next poll redraw once the user leaves a field.
  if (e.target.dataset?.key && state.job?.session) setTimeout(() => !document.activeElement?.dataset?.key && renderApply(state.job.session), 0);
});

$('#runBtn').addEventListener('click', () => void runFetch());
$('#runClose').addEventListener('click', () => $('#runDialog').close());

// ---------------------------------------------------------------- views

let currentView = 'jobs';
let viewTimer;
function showView(name) {
  currentView = name;
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  for (const v of ['jobs', 'batch', 'tracker']) $(`#view-${v}`).classList.toggle('hidden', v !== name);
  clearInterval(viewTimer);
  if (name === 'batch') {
    void loadBatch();
    viewTimer = setInterval(() => void loadBatch(), 2000);
  }
  if (name === 'tracker') void loadTracker();
  if (name === 'jobs') void refreshAll(false);
}
$('#views').addEventListener('click', (e) => {
  const b = e.target.closest('.view-btn');
  if (b) showView(b.dataset.view);
});

// ---------------------------------------------------------------- batch view

const BATCH_LABEL = {
  queued: 'Queued',
  starting: 'Opening',
  filling: 'Filling',
  needs_input: 'Needs you',
  ready: 'Ready to submit',
  captcha: 'CAPTCHA',
  submitting: 'Submitting',
  submitted: 'Applied',
  failed: "Couldn't open",
  closed: 'Closed',
  manual: 'Open yourself',
  opened: 'Opened in your browser',
};

function noFillableNote(pending) {
  return `<div class="banner" style="border-radius:8px;border:0">
    <strong>No jobs left that can be prefilled right now.</strong> Every ready job on a fillable site is either applied or waiting for your
    answer under "Did you apply?"${pending ? ` (${pending} waiting: answer "No, keep for later" to put one back in the queue)` : ''}.
    New jobs arrive with each morning's fetch, or press <em>Fetch new jobs</em>. Near misses you want anyway can be moved to Ready from the Jobs view.
  </div>`;
}

let confirmCount = 0;
async function loadBatch() {
  const [batch, confirms] = await Promise.all([api('/api/batch'), api('/api/confirmations')]);
  confirmCount = confirms.filter((j) => !['himalayas', 'remotive'].includes(j.platform)).length;
  renderConfirmations(confirms);
  const items = batch?.items ?? [];
  const count = (st) => items.filter((i) => i.state === st).length;
  const open = items.filter((i) => ['ready', 'needs_input', 'captcha'].includes(i.state)).length;
  $('#batchCount').textContent = open ? String(open) : '';
  $('#batchBtn').disabled = Boolean(batch?.filling);
  if (!batch || !items.length) {
    $('#batchSummary').textContent = batch ? 'No ready jobs left to prefill. Fetch new jobs or move near misses to ready.' : 'No batch yet. Press "Prepare next 20".';
    $('#batchTable').innerHTML = '';
    return;
  }
  const auto = items.filter((i) => !['manual', 'opened'].includes(i.state) || i.jobStatus === 'APPLIED');
  const manual = items.filter((i) => i.state === 'manual');
  const opened = items.filter((i) => i.state === 'opened');
  const done = auto.filter((i) => !['queued', 'starting', 'filling'].includes(i.state)).length;
  $('#batchSummary').textContent = batch.filling
    ? `Filling tabs: ${done} of ${auto.length} done…`
    : `${count('ready')} ready to submit · ${count('needs_input') + count('captcha')} need you · ${count('submitted')} applied · ${count('failed')} couldn't open` +
      (manual.length + opened.length ? ` · ${manual.length + opened.length} to open yourself` : '');
  const manualCard = manual.length || opened.length
    ? `<div class="card" style="margin-top:12px;background:var(--bg)"><div class="page-head"><div><strong>Open these yourself (${manual.length + opened.length})</strong>
        <div class="note">Job feeds like Himalayas block automated browsers, so these can't be prefilled. They open in your normal browser; afterwards answer "Did you apply?" above.</div></div>
        ${manual.length ? `<button class="btn primary" data-batch="open-manual">Open ${manual.length} in my browser</button>` : ''}</div>
        <table class="grid" style="margin-top:8px"><tbody>${[...manual, ...opened]
          .map((i) => `<tr><td><strong>${esc(i.company)}</strong><div class="note">${esc(i.title)} · ${esc(i.platform)}</div></td><td><span class="state ${i.state === 'opened' ? 'closed' : 'needs_input'}">${esc(BATCH_LABEL[i.state])}</span></td>
            <td><div class="row" style="justify-content:flex-end"><a class="btn ghost" href="${esc(i.url)}" target="_blank" rel="noopener">Open ↗</a></div></td></tr>`)
          .join('')}</tbody></table></div>`
    : '';
  $('#batchTable').innerHTML = (auto.length ? `<table class="grid"><thead><tr><th>Job</th><th>Status</th><th>Filled</th><th>Still needs</th><th></th></tr></thead><tbody>${auto
    .map(
      (i) => `<tr>
        <td><strong>${esc(i.company)}</strong><div class="note">${esc(i.title)} · ${esc(i.platform)}</div></td>
        <td><span class="state ${i.state}">${esc(BATCH_LABEL[i.state] ?? i.state)}</span></td>
        <td class="note">${i.total ? `${i.filled}/${i.total}` : '–'}</td>
        <td class="note">${i.missing.length ? esc(i.missing.slice(0, 3).join('; ')) + (i.missing.length > 3 ? ` +${i.missing.length - 3}` : '') : i.state === 'needs_input' ? esc(i.message) : ''}</td>
        <td><div class="row" style="justify-content:flex-end">
          ${['ready', 'needs_input', 'captcha'].includes(i.state) ? `<button class="btn" data-batch="focus" data-id="${i.id}">Go to tab</button><button class="btn ghost" data-batch="done" data-id="${i.id}">Applied</button><button class="btn ghost" data-batch="skip" data-id="${i.id}">Skip</button>` : ''}
          <button class="btn ghost" data-batch="open" data-id="${i.id}">Details</button>
        </div></td>
      </tr>`,
    )
    .join('')}</tbody></table>` : noFillableNote(confirmCount)) + manualCard;
}

function renderConfirmations(list) {
  $('#confirmCard').classList.toggle('hidden', !list.length);
  $('#confirmList').innerHTML = list
    .map(
      (j) => `<div class="confirm-row"><div><strong>${esc(j.company)}</strong> <span class="muted">${esc(j.title)}</span></div>
      <div class="row"><button class="btn primary" data-confirm="applied" data-id="${j.id}">Yes, I applied</button>
      <button class="btn" data-confirm="not_applied" data-id="${j.id}">No, keep for later</button>
      <button class="btn ghost" data-confirm="not_interested" data-id="${j.id}">Not interested</button></div></div>`,
    )
    .join('');
}

$('#view-batch').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-batch], [data-confirm]');
  if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.confirm) {
      await api(`/api/jobs/${id}/confirm`, { method: 'POST', body: { answer: b.dataset.confirm } });
    } else if (b.dataset.batch === 'open-manual') {
      const r = await api('/api/batch/open-manual', { method: 'POST' });
      toast(`Opened ${r.opened} job(s) in your browser`);
    } else if (b.dataset.batch === 'focus') {
      await api(`/api/jobs/${id}/apply/focus`, { method: 'POST' });
      toast('Switched to its tab in the assistant window');
    } else if (b.dataset.batch === 'done') {
      if (!confirm('Mark this job as applied? Only if you submitted it in its tab.')) return;
      await api(`/api/jobs/${id}/apply/done`, { method: 'POST' });
    } else if (b.dataset.batch === 'skip') {
      await api(`/api/jobs/${id}/apply/skip`, { method: 'POST' });
    } else if (b.dataset.batch === 'open') {
      showView('jobs');
      await selectJob(Number(id));
      startPolling();
      return;
    }
    await loadBatch();
  } catch (err) {
    toast(err.message);
  }
});

$('#batchBtn').addEventListener('click', async () => {
  try {
    const b = await api('/api/batch', { method: 'POST', body: {} });
    const fillable = (b?.items ?? []).filter((i) => !['manual', 'opened'].includes(i.state)).length;
    toast(
      fillable
        ? `Opening and filling ${fillable} tab(s) in the assistant Chrome window…`
        : 'No jobs left that can be prefilled right now. See the note at the top of this page.',
    );
    await loadBatch();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- tracker view

const COLORS = {
  applied: '#4c6ef5', screening: '#f59f00', assessment: '#e8590c', interview: '#9c36b5', offer: '#2f9e44', accepted: '#2f9e44',
  rejected: '#e03131', withdrawn: '#868e96', no_response: '#868e96', follow_up: '#1098ad', note: '#adb5bd',
};
const LABEL = (t) => t.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
const tracker = { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), data: null, filter: '' };

async function loadTracker() {
  tracker.data = await api('/api/tracker');
  const s = tracker.data.stats;
  $('#trackerStats').innerHTML = [
    ['Applied', s.total], ['This week', s.thisWeek], ['Response rate', `${s.responseRate}%`],
    ['Interviews', s.interviews], ['Offers', s.offers], ['Waiting 3+ weeks', s.waiting],
  ].map(([k, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');
  const sel = $('#stageFilter');
  if (sel.options.length === 1) sel.insertAdjacentHTML('beforeend', tracker.data.stages.map((st) => `<option value="${st}">${LABEL(st)}</option>`).join(''));
  $('#legend').innerHTML = ['applied', 'screening', 'interview', 'offer', 'rejected', 'follow_up']
    .map((t) => `<span style="--c:${COLORS[t]}">${LABEL(t)}</span>`).join('');
  await renderCalendar();
  renderUpcoming();
  renderAppTable();
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function renderCalendar() {
  const m = tracker.month;
  $('#calTitle').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // Grid starts on the Monday on/before the 1st and covers 6 weeks.
  const start = new Date(m);
  start.setDate(1 - ((m.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 42);
  const events = await api(`/api/calendar?from=${start.toISOString()}&to=${end.toISOString()}`);
  const byDay = new Map();
  for (const e of events) {
    const k = isoDay(new Date(e.at));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const today = isoDay(new Date());
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = isoDay(d);
    const evs = byDay.get(k) ?? [];
    html += `<div class="day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}"><span class="n">${d.getDate()}</span>
      ${evs.slice(0, 3).map((e) => `<button class="ev" style="--c:${COLORS[e.type] ?? '#adb5bd'}" data-app="${e.job_id}" title="${esc(`${LABEL(e.type)}: ${e.company} - ${e.title}${e.note ? `\n${e.note}` : ''}`)}">${esc(e.company)}</button>`).join('')}
      ${evs.length > 3 ? `<span class="more">+${evs.length - 3} more</span>` : ''}</div>`;
  }
  $('#calendar').innerHTML = html;
}

function renderUpcoming() {
  const now = new Date().toISOString();
  const soon = tracker.data.applications
    .flatMap((a) => a.events.filter((e) => e.at > now).map((e) => ({ ...e, company: a.company, title: a.title })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 10);
  const waiting = tracker.data.applications.filter((a) => a.stage === 'applied' && a.days >= 21).slice(0, 5);
  $('#upcoming').innerHTML =
    (soon.length
      ? soon.map((e) => `<div class="confirm-row" style="cursor:pointer" data-app="${e.job_id}"><div><span class="stage-chip" style="--c:${COLORS[e.type]}">${LABEL(e.type)}</span> <strong>${esc(e.company)}</strong><div class="note">${new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${e.note ? ` · ${esc(e.note)}` : ''}</div></div></div>`).join('')
      : '<div class="muted small">Nothing scheduled. Add interviews or follow-ups from an application.</div>') +
    (waiting.length
      ? `<h3 style="margin-top:14px">No reply for 3+ weeks</h3>${waiting.map((a) => `<div class="confirm-row" style="cursor:pointer" data-app="${a.id}"><div><strong>${esc(a.company)}</strong><div class="note">${a.days} days · consider a follow-up</div></div></div>`).join('')}`
      : '');
}

function renderAppTable() {
  const apps = tracker.data.applications.filter((a) => !tracker.filter || a.stage === tracker.filter);
  if (!apps.length) {
    $('#appTable').innerHTML = '<div class="muted small" style="padding:8px 0">No applications yet. Applications you submit through the batch show up here automatically.</div>';
    return;
  }
  $('#appTable').innerHTML = `<table class="grid"><thead><tr><th>Company</th><th>Role</th><th>Applied</th><th>Stage</th><th>Last update</th><th>Next</th></tr></thead><tbody>${apps
    .map(
      (a) => `<tr class="clickable" data-app="${a.id}">
        <td><strong>${esc(a.company)}</strong></td>
        <td>${esc(a.title)}</td>
        <td class="note">${day(a.applied_at)} · ${a.days}d</td>
        <td><span class="stage-chip" style="--c:${COLORS[a.stage]}">${LABEL(a.stage)}</span></td>
        <td class="note">${a.last_event ? `${LABEL(a.last_event.type)} ${day(a.last_event.at)}` : ''}</td>
        <td class="note">${a.next_event ? `${LABEL(a.next_event.type)} ${day(a.next_event.at)}` : ''}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function openApp(id) {
  const a = tracker.data?.applications.find((x) => x.id === id);
  if (!a) return;
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  $('#appDialogBody').innerHTML = `
    <div class="dialog-head"><div><strong>${esc(a.company)}</strong><div class="muted">${esc(a.title)} · ${esc(a.location)}</div></div>
      <button class="btn ghost" type="button" data-dlg="close">Close</button></div>
    <div class="row" style="margin-bottom:12px">
      <label class="note">Stage <select class="field-input" id="dlgStage" style="width:auto">${tracker.data.stages.map((s) => `<option value="${s}" ${s === a.stage ? 'selected' : ''}>${LABEL(s)}</option>`).join('')}</select></label>
      <span class="note">Applied ${day(a.applied_at)} (${a.days} days ago)</span>
      ${a.url && /^https?:/.test(a.url) ? `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Open posting ↗</a>` : ''}
    </div>
    <h3>Timeline</h3>
    <ul class="timeline">${a.events.map((e) => `<li><span class="when">${new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span><span class="stage-chip" style="--c:${COLORS[e.type]}">${LABEL(e.type)}</span><span>${esc(e.note ?? '')}</span><button class="del" data-del="${e.id}" title="Delete">×</button></li>`).join('')}</ul>
    <h3 style="margin-top:14px">Add to timeline</h3>
    <div class="form-grid">
      <label>What happened<select class="field-input" id="evType">${tracker.data.eventTypes.filter((t) => t !== 'applied').map((t) => `<option value="${t}">${LABEL(t)}</option>`).join('')}</select></label>
      <label>When<input class="field-input" type="datetime-local" id="evAt" value="${localNow}" /></label>
      <label class="span2">Note<input class="field-input" id="evNote" placeholder="e.g. Round 1 with QA lead, HR call with Priya" /></label>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn primary" data-dlg="add">Add</button></div>
    <h3 style="margin-top:14px">Notes</h3>
    <textarea class="field-input" id="dlgNotes">${esc(a.notes ?? '')}</textarea>
    <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn" data-dlg="notes">Save notes</button></div>`;
  $('#appDialog').dataset.id = String(id);
  if (!$('#appDialog').open) $('#appDialog').showModal();
}

async function refreshTrackerKeepDialog() {
  const id = Number($('#appDialog').dataset.id);
  await loadTracker();
  if ($('#appDialog').open) openApp(id);
}

$('#appDialog').addEventListener('click', async (e) => {
  const id = Number($('#appDialog').dataset.id);
  const b = e.target.closest('[data-dlg], [data-del]');
  if (!b) return;
  try {
    if (b.dataset.dlg === 'close') return $('#appDialog').close();
    if (b.dataset.del) {
      await api(`/api/events/${b.dataset.del}`, { method: 'DELETE' });
    } else if (b.dataset.dlg === 'add') {
      await api(`/api/jobs/${id}/events`, { method: 'POST', body: { type: $('#evType').value, at: new Date($('#evAt').value).toISOString(), note: $('#evNote').value } });
    } else if (b.dataset.dlg === 'notes') {
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: { notes: $('#dlgNotes').value } });
      toast('Notes saved');
    }
    await refreshTrackerKeepDialog();
  } catch (err) {
    toast(err.message);
  }
});
$('#appDialog').addEventListener('change', async (e) => {
  if (e.target.id !== 'dlgStage') return;
  await api(`/api/jobs/${$('#appDialog').dataset.id}`, { method: 'PATCH', body: { pipeline_stage: e.target.value } });
  await refreshTrackerKeepDialog();
});

$('#view-tracker').addEventListener('click', (e) => {
  const t = e.target.closest('[data-app]');
  if (t) openApp(Number(t.dataset.app));
});
$('#stageFilter').addEventListener('change', (e) => {
  tracker.filter = e.target.value;
  renderAppTable();
});
$('#calPrev').addEventListener('click', () => {
  tracker.month = new Date(tracker.month.getFullYear(), tracker.month.getMonth() - 1, 1);
  void renderCalendar();
});
$('#calNext').addEventListener('click', () => {
  tracker.month = new Date(tracker.month.getFullYear(), tracker.month.getMonth() + 1, 1);
  void renderCalendar();
});
$('#calToday').addEventListener('click', () => {
  tracker.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  void renderCalendar();
});

$('#addAppBtn').addEventListener('click', () => {
  $('#addForm').reset();
  $('#addForm').appliedAt.value = isoDay(new Date());
  $('#addDialog').showModal();
});
$('#addCancel').addEventListener('click', () => $('#addDialog').close());
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/applications', { method: 'POST', body: { ...Object.fromEntries(f), appliedAt: f.get('appliedAt') ? new Date(`${f.get('appliedAt')}T12:00:00`).toISOString() : undefined } });
    $('#addDialog').close();
    toast('Application added');
    await loadTracker();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- start

await refreshAll(false);
if (state.jobs[0]) await selectJob(state.jobs[0].id);
// The batch badge stays current on every view.
setInterval(async () => {
  if (currentView === 'batch') return;
  const b = await api('/api/batch').catch(() => null);
  const open = (b?.items ?? []).filter((i) => ['ready', 'needs_input', 'captcha'].includes(i.state)).length;
  $('#batchCount').textContent = open ? String(open) : '';
}, 4000);
