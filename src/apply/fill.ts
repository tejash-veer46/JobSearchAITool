import type { Frame } from 'playwright-core';
import { matchOption } from './answers.js';
import type { FormField } from './fields.js';

const TIMEOUT = 5000;

/** Puts one value into one field. Throws with a readable message when it cannot. */
export async function fillField(frame: Frame, field: FormField, value: string): Promise<void> {
  const el = frame.locator(`[data-jaa="${field.key}"]`);

  switch (field.kind) {
    case 'file':
      await el.setInputFiles(value, { timeout: TIMEOUT });
      return;

    case 'select': {
      const opt = matchOption(field.options, value);
      if (!opt) throw new Error(`"${value}" is not one of the options`);
      await el.selectOption({ label: opt }, { timeout: TIMEOUT });
      return;
    }

    case 'combobox': {
      await el.click({ timeout: TIMEOUT });
      const target = field.typeahead ? value : (matchOption(field.options, value) ?? value);
      const readOptions = async () => {
        const listId = await el.getAttribute('aria-controls');
        const options = listId ? frame.locator(`[id="${listId}"] [role="option"]`) : frame.locator('[role="listbox"] [role="option"]');
        await options.first().waitFor({ timeout: field.typeahead ? 2500 : 1500 }).catch(() => {});
        return { options, texts: (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()) };
      };
      await el.fill(target, { timeout: TIMEOUT });
      let { options, texts } = await readOptions();
      let pick = matchOption(texts, target);
      if (!pick) {
        // Typing can filter everything out (e.g. "1.8" against "0-2yrs"): clear it and match against the full list.
        await el.fill('', { timeout: TIMEOUT });
        ({ options, texts } = await readOptions());
        pick = matchOption(texts, value);
      }
      if (!pick) {
        await el.press('Escape');
        throw new Error(`no option matching "${value}"`);
      }
      await options.nth(texts.indexOf(pick)).click({ timeout: TIMEOUT });
      return;
    }

    case 'radio':
    case 'checkboxes': {
      const wanted = field.kind === 'radio' ? [value] : value.split(/\s*[,;]\s*/);
      for (const w of wanted) {
        const opt = matchOption(field.options, w);
        if (!opt) throw new Error(`"${w}" is not one of the options`);
        await el.nth(field.options.indexOf(opt)).check({ force: true, timeout: TIMEOUT });
      }
      return;
    }

    case 'checkbox':
      if (/^(yes|true|on|checked)$/i.test(value)) await el.check({ force: true, timeout: TIMEOUT });
      else await el.uncheck({ force: true, timeout: TIMEOUT });
      return;

    default:
      await el.fill(value, { timeout: TIMEOUT });
      // Address/city autocompletes (e.g. Lever "Current location") need a suggestion picked.
      if (field.typeahead) {
        await frame.waitForTimeout(800);
        const first = frame.locator('[role="listbox"] [role="option"], .dropdown-results > div').first();
        if (await first.isVisible().catch(() => false)) await first.click();
      }
  }
}
