import type { DiagnosticFlags, GrainStats } from '../grain/types';
import { DEFAULT_DIAGNOSTIC_FLAGS } from '../grain/types';

export interface DiagnosticHost {
  postDiagnostic(patch: Partial<DiagnosticFlags>): void;
  postMuteInstance(instance: number, muted: boolean): void;
  postPhaseInstance(instance: number, offsetFrames: number | null): void;
  postDiagnosis(on: boolean): void;
}

interface DiagRefs {
  switches: Record<keyof DiagnosticFlags, HTMLInputElement>;
  startBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  mismatchState: HTMLElement;
  mismatchFrame: HTMLElement;
  mismatchDelta: HTMLElement;
  mismatchStage: HTMLElement;
  mismatchInstances: HTMLElement;
  instanceId: HTMLInputElement;
  phaseOffset: HTMLInputElement;
  muteBtn: HTMLButtonElement;
  unmuteBtn: HTMLButtonElement;
  applyPhaseBtn: HTMLButtonElement;
  clearPhaseBtn: HTMLButtonElement;
  mutedList: HTMLElement;
  phaseList: HTMLElement;
  duplicateCount: HTMLElement;
  endReachedCount: HTMLElement;
  ledgerBody: HTMLTableSectionElement;
}

function refs(): DiagRefs {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    switches: {
      fixSourceOverrun: get<HTMLInputElement>('fixSourceOverrun'),
      fixWindowMix: get<HTMLInputElement>('fixWindowMix'),
      injectDoubleTrigger: get<HTMLInputElement>('injectDoubleTrigger'),
      injectWindowNormError: get<HTMLInputElement>('injectWindowNormError'),
      injectSourceOverrun: get<HTMLInputElement>('injectSourceOverrun'),
      seedFrozen: get<HTMLInputElement>('seedFrozen'),
    },
    startBtn: get<HTMLButtonElement>('diagStartBtn'),
    stopBtn: get<HTMLButtonElement>('diagStopBtn'),
    mismatchState: get('mismatchState'),
    mismatchFrame: get('mismatchFrame'),
    mismatchDelta: get('mismatchDelta'),
    mismatchStage: get('mismatchStage'),
    mismatchInstances: get('mismatchInstances'),
    instanceId: get<HTMLInputElement>('instanceId'),
    phaseOffset: get<HTMLInputElement>('phaseOffset'),
    muteBtn: get<HTMLButtonElement>('muteInstanceBtn'),
    unmuteBtn: get<HTMLButtonElement>('unmuteInstanceBtn'),
    applyPhaseBtn: get<HTMLButtonElement>('applyPhaseBtn'),
    clearPhaseBtn: get<HTMLButtonElement>('clearPhaseBtn'),
    mutedList: get('mutedList'),
    phaseList: get('phaseList'),
    duplicateCount: get('duplicateCount'),
    endReachedCount: get('endReachedCount'),
    ledgerBody: get<HTMLTableSectionElement>('ledgerBody'),
  };
}

const STAGE_LABEL: Record<string, string> = {
  none: '无（健康）',
  'source-overrun': '源端越界 source-overrun',
  'window-mix': '窗叠加 window-mix',
  unknown: '未知 unknown',
};

export function createDiagnosticPanel(host: DiagnosticHost): DiagRefs {
  const r = refs();

  for (const key of Object.keys(r.switches) as (keyof DiagnosticFlags)[]) {
    const input = r.switches[key];
    input.checked = DEFAULT_DIAGNOSTIC_FLAGS[key];
    input.addEventListener('change', () => {
      host.postDiagnostic({ [key]: input.checked } as Partial<DiagnosticFlags>);
    });
  }

  r.startBtn.addEventListener('click', () => host.postDiagnosis(true));
  r.stopBtn.addEventListener('click', () => host.postDiagnosis(false));

  const readInstance = (): number | null => {
    const n = Math.floor(Number(r.instanceId.value));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  r.muteBtn.addEventListener('click', () => {
    const n = readInstance();
    if (n !== null) host.postMuteInstance(n, true);
  });
  r.unmuteBtn.addEventListener('click', () => {
    const n = readInstance();
    if (n !== null) host.postMuteInstance(n, false);
  });
  r.applyPhaseBtn.addEventListener('click', () => {
    const n = readInstance();
    const offset = Math.round(Number(r.phaseOffset.value));
    if (n !== null && Number.isFinite(offset)) host.postPhaseInstance(n, offset);
  });
  r.clearPhaseBtn.addEventListener('click', () => {
    const n = readInstance();
    if (n !== null) host.postPhaseInstance(n, null);
  });

  return r;
}

export function renderDiagnosticPanel(r: DiagRefs, stats: GrainStats): void {
  // Reflect authoritative switch state coming back from the audio thread.
  for (const key of Object.keys(r.switches) as (keyof DiagnosticFlags)[]) {
    r.switches[key].checked = stats.diagnostic[key];
  }

  const mismatch = stats.mixMismatch;
  if (!mismatch) {
    r.mismatchState.textContent = '一致（无偏差）';
    r.mismatchState.className = 'stage-none';
    r.mismatchFrame.textContent = '—';
    r.mismatchDelta.textContent = '—';
    r.mismatchStage.textContent = '—';
    r.mismatchStage.className = '';
    r.mismatchInstances.textContent = '—';
  } else {
    r.mismatchState.textContent = '发现不符';
    r.mismatchState.className = 'stage-unknown';
    r.mismatchFrame.textContent = `${mismatch.frame}`;
    r.mismatchDelta.textContent = mismatch.delta.toExponential(3);
    r.mismatchStage.textContent = STAGE_LABEL[mismatch.attributedStage] ?? mismatch.attributedStage;
    r.mismatchStage.className =
      mismatch.attributedStage === 'source-overrun'
        ? 'stage-source'
        : mismatch.attributedStage === 'window-mix'
          ? 'stage-window'
          : 'stage-unknown';
    r.mismatchInstances.textContent = mismatch.activeInstances.length ? mismatch.activeInstances.join(', ') : '—';
  }

  r.mutedList.textContent = stats.mutedInstances.length ? stats.mutedInstances.join(', ') : '无';
  r.phaseList.textContent = stats.phaseOffsets.length
    ? stats.phaseOffsets.map((p) => `#${p.instance}:${p.offsetFrames}`).join('  ')
    : '无';
  r.duplicateCount.textContent = `${stats.duplicateSpawns}`;
  r.endReachedCount.textContent = `${stats.endReachedReads}`;

  // Keep the ledger table bounded; the stats already carry the newest 256 events.
  const rows = stats.grainEvents;
  const shown = rows.slice(-40);
  const frag = document.createDocumentFragment();
  for (const ev of shown) {
    const tr = document.createElement('tr');
    if (ev.muted) tr.className = 'flag-muted';
    else if (ev.duplicate) tr.className = 'flag-dup';
    else if (ev.truncated) tr.className = 'flag-trunc';
    const flags = [
      ev.duplicate ? '重复' : '',
      ev.truncated ? '截断' : '',
      ev.muted ? '静音' : '',
      ev.phaseOffset ? `相位${ev.phaseOffset}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    tr.innerHTML =
      `<td>${ev.instance}</td>` +
      `<td>${ev.spawnFrame}</td>` +
      `<td>${ev.sourceStart}</td>` +
      `<td>${ev.sourceEnd.toFixed(0)}</td>` +
      `<td>${ev.length}</td>` +
      `<td>${ev.rate.toFixed(2)}</td>` +
      `<td>${flags || '—'}</td>`;
    frag.appendChild(tr);
  }
  r.ledgerBody.replaceChildren(frag);
}
