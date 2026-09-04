/**
 * In-app modal dialogs in the LightWave Modeler idiom.
 *
 * These exist because native confirm()/alert() force the browser OUT of
 * fullscreen — on a projector rig that drops the whole calibration
 * display every time you reset a grid or rebuild the mosaic. Everything
 * here is plain DOM inside the page, so fullscreen survives.
 *
 * `modalOpen()` lets the app's global key handler stand down while a
 * dialog owns the keyboard.
 */
import { el } from './dom';

let openCount = 0;

export function modalOpen(): boolean {
  return openCount > 0;
}

interface DialogOpts {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string | null;
  /** OK is the destructive choice — render it accordingly */
  danger?: boolean;
}

function dialog(opts: DialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    openCount++;
    const prevFocus = document.activeElement as HTMLElement | null;

    const wrap = el('div', 'lw-modal');
    const panel = el('div', 'lw-modal-panel');
    panel.appendChild(el('div', 'lw-modal-title', opts.title));
    panel.appendChild(el('div', 'lw-modal-msg', opts.message));

    const row = el('div', 'lw-modal-row');
    const okBtn = el('button', 'lw-btn lw-modal-btn', opts.okLabel ?? 'OK');
    if (opts.danger) okBtn.classList.add('danger');
    const cancelBtn =
      opts.cancelLabel === null ? null : el('button', 'lw-btn lw-modal-btn', opts.cancelLabel ?? 'Cancel');

    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      openCount--;
      window.removeEventListener('keydown', onKey, true);
      wrap.remove();
      prevFocus?.focus?.();
      resolve(v);
    };

    // Capture phase so the app's window-level handler never sees these.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(cancelBtn ? false : true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn ?? okBtn : okBtn).focus();
      }
    };
    window.addEventListener('keydown', onKey, true);

    okBtn.addEventListener('click', () => finish(true));
    cancelBtn?.addEventListener('click', () => finish(false));
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap && cancelBtn) finish(false);
    });

    if (cancelBtn) row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    panel.appendChild(row);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    okBtn.focus();
  });
}

/** Destructive-action confirmation. Resolves true when the user accepts. */
export function confirmModal(message: string, title = 'CONFIRM', okLabel = 'OK'): Promise<boolean> {
  return dialog({ title, message, okLabel, danger: true });
}

/** Informational / error dialog. Always resolves true. */
export function alertModal(message: string, title = 'NOTICE'): Promise<boolean> {
  return dialog({ title, message, okLabel: 'OK', cancelLabel: null });
}
