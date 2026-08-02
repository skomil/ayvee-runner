interface Profile {
  id: string;
  label: string;
  kind: string;
  cwd: string;
  command: string;
}

interface Session {
  id: string;
  profileId: string;
  kind: string;
  name: string;
  createdAt: string;
  status: string;
  tmuxName?: string;
  remoteControl?: boolean;
  model?: string;
  exitCode?: number | null;
}

interface SessionEvent {
  seq: number;
  ts: string;
  data: unknown;
}

interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

interface ClaudeMetrics {
  windowHours: number;
  window: TokenCounts;
  lifetime: TokenCounts;
  limit: {
    tokens: number | null;
    usedPercent: number | null;
    remainingTokens: number | null;
    remainingPercent: number | null;
  };
}

const KEY_STORAGE = 'ayvee-runner-api-key';
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let apiKey = localStorage.getItem(KEY_STORAGE) ?? '';
let inspected: Session | null = null;
let lastSeq = 0;

function showError(message: string): void {
  const el = $('#error');
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 4000);
}

/**
 * Directory of the current document, so every request is relative and the
 * dashboard works under a reverse-proxy path prefix (e.g. /runners/vm/).
 */
const API_BASE = document.baseURI.replace(/[^/]*$/, '');

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  // Health and metrics are anonymous; sending an empty bearer would be an
  // invalid header, so only attach it once a key has been entered.
  if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(new URL(`api${path}`, API_BASE), { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function cell(row: HTMLTableRowElement, ...children: (string | HTMLElement)[]): HTMLTableCellElement {
  const td = document.createElement('td');
  td.append(...children);
  row.appendChild(td);
  return td;
}

function actionButton(label: string, danger: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (danger) btn.classList.add('danger');
  btn.addEventListener('click', onClick);
  return btn;
}

async function refreshHealth(): Promise<void> {
  const el = $('#health');
  try {
    const h = await api<{
      name: string;
      version: string;
      uptimeSeconds: number;
      sessions: { running: number; total: number };
    }>('/health');
    $('#runner-name').textContent = h.name;
    document.title = `${h.name} · ayvee-runner`;
    el.textContent = `healthy · v${h.version} · up ${h.uptimeSeconds}s · ${h.sessions.running} running / ${h.sessions.total} sessions`;
    el.className = 'health ok';
  } catch (err) {
    el.textContent = `unreachable — ${(err as Error).message}`;
    el.className = 'health bad';
  }
}

async function refreshProfiles(): Promise<void> {
  const { profiles } = await api<{ profiles: Profile[] }>('/profiles');
  const tbody = $('#profiles').querySelector('tbody') as HTMLElement;
  clearChildren(tbody);
  for (const p of profiles) {
    const row = document.createElement('tr');
    cell(row, p.label);
    cell(row, p.kind);
    const cwd = document.createElement('code');
    cwd.textContent = p.cwd;
    cell(row, cwd);
    const cmd = document.createElement('code');
    cmd.textContent = p.command;
    cell(row, cmd);
    const launch = (remoteControl: boolean) => () => {
      const model = ($('#model-input') as HTMLInputElement).value.trim();
      void api('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          profileId: p.id,
          ...(remoteControl ? { remoteControl } : {}),
          ...(model !== '' ? { model } : {}),
        }),
      })
        .then(refreshAll)
        .catch((err: Error) => showError(err.message));
    };
    const buttons = [actionButton('Launch', false, launch(false))];
    if (p.kind === 'tmux') {
      buttons.push(actionButton('Launch remote control', false, launch(true)));
    }
    cell(row, ...buttons);
    tbody.appendChild(row);
  }
}

async function refreshSessions(): Promise<void> {
  const { sessions } = await api<{ sessions: Session[] }>('/sessions');
  const tbody = $('#sessions').querySelector('tbody') as HTMLElement;
  clearChildren(tbody);
  if (inspected && !sessions.some((s) => s.id === inspected!.id)) {
    inspected = null;
    $('#inspect-section').hidden = true;
  }
  for (const s of sessions) {
    const row = document.createElement('tr');
    cell(row, s.name);
    const kindBits = [s.kind];
    if (s.remoteControl) kindBits.push('remote control');
    if (s.model) kindBits.push(s.model);
    cell(row, kindBits.join(' · '));
    const status = cell(row, s.status);
    status.className = `status-${s.status}`;
    cell(row, new Date(s.createdAt).toLocaleString());
    if (s.kind === 'tmux') {
      const code = document.createElement('code');
      code.textContent = `tmux attach -t ${s.tmuxName}`;
      cell(row, code);
    } else {
      cell(row, s.exitCode != null ? `exit ${s.exitCode}` : '—');
    }
    const actions = [actionButton('Kill', true, () => void killSession(s.id))];
    if (s.kind === 'headless') {
      actions.unshift(actionButton('Inspect', false, () => inspect(s)));
    }
    cell(row, ...actions);
    tbody.appendChild(row);
  }
}

interface RunnerDescriptor {
  runnerId: string;
  name: string;
  version: string;
  registerUrl: string;
}

interface Registration {
  id: string;
  ayveeUrl: string;
  label: string | null;
  registeredAt: string;
}

async function refreshRegistration(): Promise<void> {
  const descriptor = await api<RunnerDescriptor>('/registration');
  ($('#register-url') as HTMLInputElement).value = descriptor.registerUrl;
  $('#runner-id').textContent = descriptor.runnerId;
}

async function refreshRegistrations(): Promise<void> {
  const { registrations } = await api<{ registrations: Registration[] }>('/registrations');
  const table = $('#registrations');
  const tbody = table.querySelector('tbody') as HTMLElement;
  clearChildren(tbody);
  table.hidden = registrations.length === 0;
  for (const reg of registrations) {
    const row = document.createElement('tr');
    const url = document.createElement('code');
    url.textContent = reg.ayveeUrl;
    cell(row, url);
    cell(row, reg.label ?? '—');
    cell(row, new Date(reg.registeredAt).toLocaleString());
    cell(
      row,
      actionButton('Remove', true, () => {
        void api(`/registrations/${reg.id}`, { method: 'DELETE' })
          .then(refreshAll)
          .catch((err: Error) => showError(err.message));
      }),
    );
    tbody.appendChild(row);
  }
}

interface ClaudeLimit {
  label: string;
  scope: string;
  model: string | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string;
}

interface UsagePeriod {
  label: string;
  requests: number | null;
  sessions: number | null;
  behaviors: Array<{ percent: number; description: string }>;
  breakdowns: Array<{ category: string; entries: Array<{ name: string; percent: number }> }>;
}

interface ClaudeLimits {
  source: string;
  fetchedAt: string;
  summary: string | null;
  note: string;
  limits: ClaudeLimit[];
  periods: UsagePeriod[];
}

function barFor(usedPercent: number): HTMLElement {
  const meter = document.createElement('div');
  meter.className = 'meter';
  const bar = document.createElement('div');
  bar.style.width = `${Math.min(100, usedPercent)}%`;
  bar.className = usedPercent >= 90 ? 'bar danger' : usedPercent >= 75 ? 'bar warn' : 'bar';
  meter.appendChild(bar);
  return meter;
}

/** Render the real limits the Claude CLI reports, in its own wording. */
function renderClaudeLimits(limits: ClaudeLimits | null): boolean {
  const section = $('#claude-limits');
  const list = $('#limits-list');
  clearChildren(list);
  if (!limits || limits.limits.length === 0) {
    section.hidden = true;
    return false;
  }

  const session = limits.limits.find((l) => l.scope === 'session') ?? limits.limits[0]!;
  const headline = $('#limit-headline');
  headline.textContent = `${session.remainingPercent}% left`;
  headline.hidden = false;
  $('#limit-line').textContent =
    `${session.label}: ${session.usedPercent}% used · resets ${session.resetsAt}`;
  $('#limit-meter').hidden = true; // each row carries its own meter below

  for (const limit of limits.limits) {
    const row = document.createElement('div');
    row.className = 'limit-row';
    const label = document.createElement('span');
    label.className = 'limit-label';
    label.textContent = limit.label;
    const detail = document.createElement('span');
    detail.className = 'limit-detail';
    detail.textContent =
      `${limit.remainingPercent}% left · ${limit.usedPercent}% used · resets ${limit.resetsAt}`;
    row.append(label, barFor(limit.usedPercent), detail);
    list.appendChild(row);
  }
  $('#limits-note').textContent = limits.note;
  renderContributors(limits.periods);
  section.hidden = false;
  return true;
}

/** "What's contributing to your limits usage" — the CLI's own breakdown. */
function renderContributors(periods: UsagePeriod[]): void {
  const section = $('#contributors');
  const list = $('#contributors-list');
  clearChildren(list);
  section.hidden = periods.length === 0;

  for (const period of periods) {
    const block = document.createElement('div');
    block.className = 'period';

    const heading = document.createElement('div');
    heading.className = 'period-head';
    const counts = [
      period.requests === null ? null : `${period.requests.toLocaleString()} requests`,
      period.sessions === null ? null : `${period.sessions.toLocaleString()} sessions`,
    ].filter((part): part is string => part !== null);
    heading.textContent = counts.length > 0 ? `${period.label} · ${counts.join(' · ')}` : period.label;
    block.appendChild(heading);

    for (const behavior of period.behaviors) {
      const line = document.createElement('div');
      line.className = 'period-line';
      line.textContent = `${behavior.percent}% ${behavior.description}`;
      block.appendChild(line);
    }
    for (const breakdown of period.breakdowns) {
      const line = document.createElement('div');
      line.className = 'period-line';
      const label = document.createElement('span');
      label.className = 'period-key';
      label.textContent = `Top ${breakdown.category}: `;
      line.append(
        label,
        breakdown.entries.map((e) => `${e.name} ${e.percent}%`).join(', '),
      );
      block.appendChild(line);
    }
    list.appendChild(block);
  }
}

async function refreshMetrics(): Promise<void> {
  const { claude, limits } = await api<{ claude: ClaudeMetrics; limits: ClaudeLimits | null }>(
    '/metrics',
  );
  // Real CLI limits win; the configured token limit is only a fallback.
  if (renderClaudeLimits(limits)) {
    renderTokenTable(claude);
    return;
  }
  const { tokens, usedPercent, remainingTokens, remainingPercent } = claude.limit;
  const headline = $('#limit-headline');
  const limitLine = $('#limit-line');
  const meter = $('#limit-meter');
  const bar = $('#limit-bar');

  if (tokens !== null && remainingPercent !== null && remainingTokens !== null) {
    headline.textContent = `${remainingPercent}% left`;
    headline.hidden = false;
    limitLine.textContent =
      `${remainingTokens.toLocaleString()} of ${tokens.toLocaleString()} tokens left in the ` +
      `${claude.windowHours}-hour window — ${claude.window.total.toLocaleString()} used ` +
      `(${usedPercent}%).`;
    bar.style.width = `${Math.min(100, usedPercent ?? 0)}%`;
    // Green while there's headroom, amber past 75%, red past 90% used.
    bar.className = (usedPercent ?? 0) >= 90 ? 'bar danger' : (usedPercent ?? 0) >= 75 ? 'bar warn' : 'bar';
    meter.hidden = false;
  } else {
    headline.hidden = true;
    meter.hidden = true;
    limitLine.textContent =
      `${claude.window.total.toLocaleString()} tokens used in the last ${claude.windowHours}h — ` +
      'set your plan limit with `ayvee-runner set-limit <tokens>` to see how much is left.';
  }
  renderTokenTable(claude);
}

function renderTokenTable(claude: ClaudeMetrics): void {
  const rows: Array<[string, keyof TokenCounts]> = [
    ['Uncached input', 'input'],
    ['Output', 'output'],
    ['Cache write', 'cacheCreation'],
    ['Cache read', 'cacheRead'],
    ['Total', 'total'],
  ];
  const tbody = $('#metrics').querySelector('tbody') as HTMLElement;
  clearChildren(tbody);
  for (const [label, field] of rows) {
    const row = document.createElement('tr');
    cell(row, label);
    cell(row, claude.window[field].toLocaleString());
    cell(row, claude.lifetime[field].toLocaleString());
    tbody.appendChild(row);
  }
}

async function killSession(id: string): Promise<void> {
  try {
    await api(`/sessions/${id}`, { method: 'DELETE' });
    await refreshAll();
  } catch (err) {
    showError((err as Error).message);
  }
}

function inspect(session: Session): void {
  inspected = session;
  lastSeq = 0;
  $('#inspect-name').textContent = session.name;
  $('#events').textContent = '';
  $('#inspect-section').hidden = false;
  void refreshEvents();
}

async function refreshEvents(): Promise<void> {
  if (!inspected) return;
  try {
    const { events } = await api<{ events: SessionEvent[] }>(`/sessions/${inspected.id}/events?since=${lastSeq}`);
    if (events.length > 0) {
      lastSeq = events[events.length - 1]!.seq;
      const pre = $('#events');
      pre.textContent += events.map((e) => JSON.stringify(e.data)).join('\n') + '\n';
      pre.scrollTop = pre.scrollHeight;
    }
  } catch {
    // Session may have been killed between refreshes; the session poll hides the panel.
  }
}

async function refreshAll(): Promise<void> {
  // Status and the registration advert are anonymous: they render with or
  // without a key.
  await refreshHealth();
  await refreshMetrics().catch(() => undefined);
  await refreshRegistration().catch(() => undefined);

  const managed = apiKey !== '';
  $('#managed-hint').hidden = managed;
  for (const id of ['#profiles-section', '#sessions-section']) {
    $(id).hidden = !managed;
  }
  if (!managed) {
    inspected = null;
    $('#inspect-section').hidden = true;
    $('#registrations').hidden = true;
    return;
  }
  try {
    await refreshRegistrations();
    await refreshProfiles();
    await refreshSessions();
    await refreshEvents();
  } catch (err) {
    showError((err as Error).message);
  }
}

$('#copy-register').addEventListener('click', () => {
  const field = $('#register-url') as HTMLInputElement;
  field.select();
  void navigator.clipboard?.writeText(field.value).catch(() => undefined);
});

$('#key-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  apiKey = ($('#key-input') as HTMLInputElement).value.trim();
  localStorage.setItem(KEY_STORAGE, apiKey);
  void refreshAll();
});

$('#key-clear').addEventListener('click', () => {
  apiKey = '';
  localStorage.removeItem(KEY_STORAGE);
  ($('#key-input') as HTMLInputElement).value = '';
  void refreshAll();
});

$('#input-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!inspected) return;
  const input = $('#input-message') as HTMLInputElement;
  const message = input.value.trim();
  if (message === '') return;
  void api(`/sessions/${inspected.id}/input`, { method: 'POST', body: JSON.stringify({ message }) })
    .then(() => {
      input.value = '';
    })
    .catch((err: Error) => showError(err.message));
});

void refreshAll();
setInterval(() => void refreshAll(), 3000);
