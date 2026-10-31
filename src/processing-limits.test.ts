import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', async importOriginal => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, Setting: class {
        settingEl: HTMLElement;
        private description: HTMLElement;
        constructor(parent: HTMLElement) {
            this.settingEl = document.createElement('div');
            this.description = document.createElement('small');
            this.settingEl.appendChild(this.description);
            parent.appendChild(this.settingEl);
        }
        setName(name: string) { this.settingEl.dataset.name = name; return this; }
        setDesc(value: string) { this.description.textContent = value; return this; }
        addText(callback: (value: unknown) => void) {
            const inputEl = document.createElement('input');
            this.settingEl.appendChild(inputEl);
            const text = {
                inputEl,
                setValue(value: string) { inputEl.value = value; return text; },
                onChange(handler: (value: string) => void) {
                    inputEl.addEventListener('input', () => handler(inputEl.value));
                    return text;
                },
            };
            callback(text); return this;
        }
    } };
});
import DesktopTools from './main';
import { normalizeSettings } from './config';

function fixture() {
    const plugin = new DesktopTools();
    plugin.settings = normalizeSettings({});
    const persisted: unknown[] = [];
    const save = vi.fn(async () => { persisted.push({ ...plugin.settings }); });
    Object.assign(plugin, { savePreferences: save });
    const root = document.createElement('div');
    plugin['renderProcessingLimits'](root);
    document.body.appendChild(root);
    return { plugin, root, inputs: [...root.querySelectorAll('input')], save, persisted };
}
function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
}
async function commit(input: HTMLInputElement, enter = false) {
    input.dispatchEvent(enter ? new KeyboardEvent('keydown', { key: 'Enter' }) : new Event('change'));
    await Promise.resolve(); await Promise.resolve();
}
beforeEach(() => document.body.replaceChildren());

describe('processing limit settings', () => {
    it.each(['', ' ', '1001', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2'])('does not save invalid comment limit %j and restores the last value', async value => {
        const f = fixture(), input = f.inputs[1];
        type(input, value);
        expect(f.plugin.settings.commentLimit).toBe(100);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(f.root.textContent).toContain('未保存：请输入 1–1000 的整数；仍使用 100');
        await commit(input);
        expect(input.value).toBe('100');
        expect(f.save).not.toHaveBeenCalled();
        expect(f.plugin.settings.commentLimit).toBe(100);
    });
    it('saves a complete valid value on change, without saving intermediate keystrokes', async () => {
        const f = fixture(), input = f.inputs[1];
        for (const value of ['1', '12', '123']) type(input, value);
        expect(f.save).not.toHaveBeenCalled();
        expect(f.plugin.settings.commentLimit).toBe(100);
        await commit(input);
        expect(f.save).toHaveBeenCalledOnce();
        expect(f.persisted[0]).toMatchObject({ commentLimit: 123 });
        expect(input.value).toBe('123');
        const refreshed = document.createElement('div');
        f.plugin['renderProcessingLimits'](refreshed);
        expect(refreshed.querySelectorAll('input')[1].value).toBe('123');
    });
    it.each([
        [0, '240', 'asrTimeoutMinutes', 240],
        [1, '1000', 'commentLimit', 1000],
        [2, '10240', 'maxBytes', 10240 * 1024 ** 2],
        [3, '120', 'timeoutMinutes', 120],
    ] as const)('saves the upper bound of input %i through Enter', async (index, value, key, expected) => {
        const f = fixture(), input = f.inputs[index];
        type(input, value); await commit(input, true);
        expect(f.plugin.settings[key]).toBe(expected);
        expect(f.persisted[0]).toMatchObject({ [key]: expected });
        expect(input.disabled).toBe(false);
        type(input, String(Number(value) + 1)); await commit(input);
        expect(input.value).toBe(value);
        expect(f.save).toHaveBeenCalledOnce();
    });
    it('rolls back the visible and saved preference after a write failure, then allows retry', async () => {
        const f = fixture(), input = f.inputs[1];
        f.save.mockRejectedValueOnce(new Error('disk full'));
        type(input, '123'); await commit(input);
        expect(f.plugin.settings.commentLimit).toBe(100);
        expect(input.value).toBe('100');
        expect(input.disabled).toBe(false);
        expect(f.root.textContent).toContain('保存失败，请重试；仍使用 100');
        type(input, '123'); await commit(input);
        expect(f.plugin.settings.commentLimit).toBe(123);
        expect(f.persisted).toHaveLength(1);
    });
});
