/**
 * Autosave (localStorage, debounced) and explicit save/load via File API.
 */
import { deserializeProject, ProjectState, serializeProject } from './project';
import { downloadText } from '../export/zip';

const LS_KEY = 'fencepost.autosave.v1';
let timer: number | undefined;

export function autosave(p: ProjectState): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, serializeProject(p));
    } catch {
      // quota/private-mode failures must never break editing
    }
  }, 250);
}

export function loadAutosave(): ProjectState | null {
  try {
    const json = localStorage.getItem(LS_KEY);
    return json ? deserializeProject(json) : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export function saveProjectFile(p: ProjectState): void {
  downloadText(serializeProject(p), `${p.name || 'fencepost-project'}.json`);
}

export function openProjectFile(onLoad: (p: ProjectState) => void, onError: (msg: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      onLoad(deserializeProject(await file.text()));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  input.click();
}
