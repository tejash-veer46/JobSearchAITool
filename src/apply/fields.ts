// Reads the fillable fields of an application form, in the page itself.
import type { Frame } from 'playwright-core';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'number'
  | 'url'
  | 'select'
  | 'combobox'
  | 'radio'
  | 'checkbox'
  | 'checkboxes'
  | 'file';

export interface FormField {
  /** Stable handle: the element (or group) is tagged with data-jaa="<key>". */
  key: string;
  kind: FieldKind;
  label: string;
  name: string;
  required: boolean;
  options: string[];
  /** Combobox whose options come from typing (country, city search). */
  typeahead?: boolean;
  currentValue: string;
}

/**
 * Runs in the browser. Tags every visible field with data-jaa and describes it.
 * Radio and checkbox groups become one field each, keyed by their name.
 */
function readFieldsInPage(): FormField[] {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/✱/g, '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (id: string) => clean(document.getElementById(id)?.innerText);

  const labelFor = (el: HTMLElement): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(textOf).join(' ').trim();
      if (t) return clean(t);
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null;
      if (l?.innerText.trim()) return clean(l.innerText);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const wrap = el.closest('label');
    if (wrap?.innerText.trim()) return clean(wrap.innerText);
    // Nearest container with a label-like child (Lever cards, fieldsets, generic form rows).
    for (let p = el.parentElement, depth = 0; p && depth < 5; p = p.parentElement, depth++) {
      const l = p.querySelector('label, legend, .application-label, [class*="label"]') as HTMLElement | null;
      if (l && !l.contains(el) && l.innerText.trim()) return clean(l.innerText);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name'));
  };

  /** Question text for a radio/checkbox group: the nearest ancestor holding all options, minus the option labels. */
  const groupLabel = (inputs: HTMLInputElement[], optionLabels: string[]): string => {
    const legend = inputs[0]!.closest('fieldset')?.querySelector('legend') as HTMLElement | null;
    if (legend?.innerText.trim()) return clean(legend.innerText);
    for (let p = inputs[0]!.parentElement; p && p !== document.body; p = p.parentElement) {
      if (!inputs.every((i) => p!.contains(i))) continue;
      const labelled = p.getAttribute('aria-labelledby');
      if (labelled) return clean(labelled.split(/\s+/).map(textOf).join(' '));
      const head = p.querySelector('.application-label, legend, [class*="label"]:not(label)') as HTMLElement | null;
      if (head?.innerText.trim() && !optionLabels.includes(clean(head.innerText))) return clean(head.innerText);
      let text = clean(p.innerText);
      for (const o of optionLabels) text = text.replace(o, ' ');
      text = clean(text);
      if (text) return clean(text.split(/\n/)[0]);
    }
    return '';
  };

  const optionLabel = (input: HTMLInputElement) =>
    clean(
      (input.id && (document.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLElement | null)?.innerText) ||
        input.closest('label')?.innerText ||
        input.value,
    );

  const fields: FormField[] = [];
  const groups = new Map<string, HTMLInputElement[]>();
  let n = 0;

  const els = document.querySelectorAll<HTMLElement>('input, textarea, select, [role="combobox"]');
  for (const el of els) {
    if (el.closest('[aria-hidden="true"]') && !(el instanceof HTMLInputElement && el.type === 'file')) continue;
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    const type = (input.type || '').toLowerCase();
    if (input.disabled || ['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type)) continue;
    if (/recaptcha|captcha/i.test(input.name || el.id || '')) continue;

    // File inputs come first: they are usually hidden (tabindex -1) behind an "Attach" button.
    if (type === 'file') {
      const key = `f${n++}`;
      el.setAttribute('data-jaa', key);
      const box = el.closest('.field, .application-question, .file-upload, fieldset, div');
      const label = labelFor(el) || clean((box as HTMLElement | null)?.innerText).slice(0, 60);
      // Greenhouse labels the input "Attach"; its id ("resume", "cover_letter") says what it is.
      fields.push({ key, kind: 'file', label, name: input.name || el.id, required: input.required, options: [], currentValue: input.files?.length ? input.files[0]!.name : '' });
      continue;
    }
    if (/requiredInput/.test(el.className) || el.tabIndex === -1) continue; // mirrors used by react-select validation

    if (type === 'radio' || type === 'checkbox') {
      if (!input.name) continue;
      const list = groups.get(input.name) ?? [];
      list.push(input);
      groups.set(input.name, list);
      continue;
    }
    if (!visible(el)) continue;

    const key = `f${n++}`;
    el.setAttribute('data-jaa', key);
    const required = input.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(labelFor(el) + (el.closest('label')?.innerText ?? ''));
    if (el.getAttribute('role') === 'combobox') {
      fields.push({ key, kind: 'combobox', label: labelFor(el), name: input.name || el.id, required, options: [], currentValue: '' });
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const options = [...sel.options].filter((o) => o.value !== '').map((o) => clean(o.text));
      fields.push({ key, kind: 'select', label: labelFor(el), name: sel.name, required, options, currentValue: sel.value ? clean(sel.selectedOptions[0]?.text) : '' });
    } else {
      const kind = tag === 'textarea' ? 'textarea' : (['email', 'tel', 'number', 'url'].includes(type) ? type : 'text') as FormField['kind'];
      const typeahead = el.getAttribute('aria-autocomplete') === 'list' || /location-input|autocomplete/i.test(el.className);
      fields.push({ key, kind, label: labelFor(el), name: input.name || el.id, required, options: [], typeahead, currentValue: input.value });
    }
  }

  for (const [name, inputs] of groups) {
    if (!inputs.some(visible) && !inputs.some((i) => visible(i.closest('label') ?? i))) continue;
    const key = `g${n++}`;
    for (const i of inputs) i.setAttribute('data-jaa', key);
    const options = inputs.map(optionLabel);
    const single = inputs.length === 1 && inputs[0]!.type === 'checkbox';
    fields.push({
      key,
      kind: inputs[0]!.type === 'radio' ? 'radio' : single ? 'checkbox' : 'checkboxes',
      label: single ? options[0]! : groupLabel(inputs, options),
      name,
      required: inputs.some((i) => i.required),
      options: single ? [] : options,
      currentValue: inputs.filter((i) => i.checked).map(optionLabel).join(', '),
    });
  }
  return fields;
}

/** Opens a combobox, reads its options, and closes it. Long lists are treated as type-ahead. */
async function loadComboOptions(frame: Frame, field: FormField): Promise<void> {
  const input = frame.locator(`[data-jaa="${field.key}"]`);
  try {
    await input.click({ timeout: 3000 });
    // Menus open slowly in background tabs: wait for the options rather than a fixed delay.
    let listId: string | null = null;
    for (let i = 0; i < 10 && !listId; i++) {
      listId = await input.getAttribute('aria-controls');
      if (!listId) await frame.waitForTimeout(200);
    }
    if (listId) await frame.locator(`[id="${listId}"] [role="option"]`).first().waitFor({ timeout: 3000 }).catch(() => {});
    const options = listId ? await frame.locator(`[id="${listId}"] [role="option"]`).allInnerTexts() : [];
    await input.press('Escape');
    if (options.length > 60 || options.length === 0) field.typeahead = true;
    else field.options = options.map((o) => o.replace(/\s+/g, ' ').trim());
  } catch {
    field.typeahead = true;
  }
}

export async function readFields(frame: Frame): Promise<FormField[]> {
  const fields = await frame.evaluate(readFieldsInPage);
  for (const f of fields) if (f.kind === 'combobox') await loadComboOptions(frame, f);
  return fields;
}

/** The frame holding the application form: the page itself, or an embedded ATS iframe. */
export async function findFormFrame(frames: Frame[]): Promise<Frame> {
  let best = frames[0]!;
  let bestCount = -1;
  for (const f of frames) {
    if (/captcha|recaptcha|googleapis|linkedin\.com\/talentwidgets/i.test(f.url())) continue;
    const count = await f.locator('input:not([type=hidden]), textarea, select').count().catch(() => 0);
    if (count > bestCount) {
      best = f;
      bestCount = count;
    }
  }
  return best;
}
