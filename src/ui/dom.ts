/**
 * Hand-rolled DOM widget helpers in the LightWave Modeler idiom: bevelled
 * buttons, etched group separators, and mini numeric fields with steppers
 * and label-scrubbing (drag the label horizontally like LW's mini-sliders).
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, onClick: () => void, cls = 'lw-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
    (e.currentTarget as HTMLButtonElement).blur(); // keep keyboard focus global
  });
  return b;
}

export function group(title: string, ...children: HTMLElement[]): HTMLElement {
  const g = el('div', 'lw-group');
  g.appendChild(el('div', 'lw-group-label', title));
  for (const c of children) g.appendChild(c);
  return g;
}

export interface MiniFieldOpts {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  /** fired on every committed value change */
  onChange: (v: number) => void;
  /** fired once when a scrub/stepper gesture begins (for undo grouping) */
  onGestureStart?: () => void;
}

export interface MiniField {
  root: HTMLElement;
  set(v: number): void;
  get(): number;
}

export function miniField(o: MiniFieldOpts): MiniField {
  const root = el('div', 'lw-field');
  const label = el('span', 'lw-field-label', o.label);
  const input = el('input');
  input.type = 'text';
  const dec = o.decimals ?? (o.step < 1 ? 2 : 0);
  let value = o.value;

  const fmt = (v: number) => v.toFixed(dec);
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));
  const display = () => {
    input.value = fmt(value);
  };

  const commit = (v: number, gesture = false) => {
    const nv = clamp(v);
    if (nv === value) {
      display();
      return;
    }
    if (!gesture) o.onGestureStart?.();
    value = nv;
    display();
    o.onChange(value);
  };

  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) commit(v);
    else display();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing in a field must not trigger app hotkeys
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      display();
      input.blur();
    }
  });

  // Label scrub: LW-style drag-left/right to slide the value.
  label.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    label.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startV = value;
    let began = false;
    const move = (ev: PointerEvent) => {
      const dv = ((ev.clientX - startX) / 4) * o.step;
      if (!began && dv !== 0) {
        began = true;
        o.onGestureStart?.();
      }
      if (began) commit(startV + dv, true);
    };
    const up = () => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
  });

  const steppers = el('div', 'lw-stepper');
  const mk = (txt: string, dir: number) => {
    const b = el('button', '', txt);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      commit(value + dir * o.step);
      b.blur();
    });
    steppers.appendChild(b);
  };
  mk('◂', -1);
  mk('▸', 1);

  root.appendChild(label);
  root.appendChild(input);
  root.appendChild(steppers);
  display();

  return {
    root,
    set(v: number) {
      value = clamp(v);
      display();
    },
    get: () => value,
  };
}

export function textField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = el('div');
  wrap.appendChild(el('div', 'lw-note', label));
  const input = el('input', 'lw-text');
  input.type = 'text';
  input.value = value;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
  });
  input.addEventListener('change', () => onChange(input.value));
  wrap.appendChild(input);
  return wrap;
}
