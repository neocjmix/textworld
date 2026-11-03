// Native Chromium ranges plus explicitly labeled standard event-order fixtures.
// These are not physical Korean/Japanese/Chinese OS keyboard acceptance tests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';
const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const passed = [];
async function scenario(name, run) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/health`);
    await page.setContent('<div id="input" contenteditable="true" role="textbox" style="white-space:pre"></div>');
    await page.evaluate(async () => {
      const { createNativeInput } = await import('/native-input.js');
      const input = document.getElementById('input');
      window.events = []; window.edits = []; window.commands = []; window.previews = []; window.unsupported = []; window.invalidations = 0; window.resets = 0;
      input.addEventListener('beforeinput', event => events.push({ type: event.inputType, ranges: event.getTargetRanges().length, composing: event.isComposing }));
      window.bridge = createNativeInput(input, {
        onEdit(edit) { edits.push(edit); return true; }, onCommand(type) { commands.push(type); },
        onPreedit(text, range) { previews.push({ text, ...range }); }, onUnsupported(type) { unsupported.push(type); },
        onInvalidated() { invalidations++; }, onReset() { resets++; },
      });
      input.focus();
    });
    const cdp = await context.newCDPSession(page);
    await run({ page, context, cdp });
    assert.deepEqual(errors, []);
    passed.push(name); console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
const state = page => page.evaluate(() => ({ edits, commands, previews, unsupported, invalidations, resets, events, text: document.getElementById('input').textContent, committed: bridge.text, composing: bridge.composing }));
const compose = (cdp, text, extra = {}) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, ...extra });
const commit = (cdp, text) => cdp.send('Input.insertText', { text });
const span = edit => ({ before: edit.before, start: edit.start, end: edit.end, text: edit.text, after: edit.after });
try {
  await scenario('Native context compacts after a completed edit and retains its final syllable for reconversion', async ({ page, cdp }) => {
    await commit(cdp, 'A'.repeat(256));
    await compose(cdp, '한');
    assert.equal((await state(page)).text, 'A'.repeat(256) + '한');
    assert.equal((await state(page)).resets, 0);
    await commit(cdp, '한');
    const rotated = await state(page);
    assert.equal(rotated.text, 'A'.repeat(127) + '한'); assert.equal(rotated.committed, rotated.text); assert.equal(rotated.resets, 0);
    assert.equal(rotated.edits.at(-1).before.length, 256);
    await compose(cdp, '韓', { replacementStart: 127, replacementEnd: 128 }); await commit(cdp, '韓');
    assert.equal((await state(page)).text, 'A'.repeat(127) + '韓');
    await compose(cdp, '글'); await commit(cdp, '글');
    assert.deepEqual(span((await state(page)).edits.at(-1)), { before: 'A'.repeat(127) + '韓', start: 128, end: 128, text: '글', after: 'A'.repeat(127) + '韓글' });
  });
  await scenario('Native rich editing host provides authoritative ranges for text and deletion', async ({ page }) => {
    await page.keyboard.type('ABC'); await page.keyboard.press('Backspace');
    const s = await state(page);
    assert.ok(s.events.every(event => event.ranges === 1));
    assert.deepEqual(span(s.edits.at(-1)), { before: 'ABC', start: 2, end: 3, text: '', after: 'AB' });
    assert.equal(s.text, 'AB'); assert.equal(s.committed, 'AB');
  });
  await scenario('Korean provisional jamo is replaced at its browser-supplied range', async ({ page, cdp }) => {
    await commit(cdp, 'ㅎ'); await compose(cdp, '하', { replacementStart: 0, replacementEnd: 1 });
    assert.equal((await state(page)).edits.length, 1);
    await compose(cdp, '한'); await commit(cdp, '한');
    const s = await state(page);
    assert.deepEqual(span(s.edits.at(-1)), { before: 'ㅎ', start: 0, end: 1, text: '한', after: '한' });
    assert.equal(s.edits.length, 2); assert.equal(s.text, '한'); assert.equal(s.composing, false);
    assert.ok(s.previews.some(p => p.text === '하' && p.start === 0 && p.end === 1));
  });
  await scenario('Consecutive Korean syllables preserve native context without replaying the prefix', async ({ page, cdp }) => {
    await compose(cdp, '한'); await commit(cdp, '한'); await compose(cdp, '글'); await commit(cdp, '글');
    const s = await state(page);
    assert.deepEqual(s.edits.map(span), [
      { before: '', start: 0, end: 0, text: '한', after: '한' },
      { before: '한', start: 1, end: 1, text: '글', after: '한글' },
    ]);
  });
  await scenario('Chinese multi-character conversion commits one range, never the Pinyin draft', async ({ page, cdp }) => {
    await compose(cdp, 'nihao'); await compose(cdp, '你好'); assert.equal((await state(page)).edits.length, 0);
    await commit(cdp, '你好'); const s = await state(page);
    assert.deepEqual(s.edits.map(span), [{ before: '', start: 0, end: 0, text: '你好', after: '你好' }]);
  });
  await scenario('Japanese reconversion replaces a middle range and retains the untouched suffix', async ({ page, cdp }) => {
    await commit(cdp, '日本へ行く');
    await compose(cdp, 'にほん', { replacementStart: 0, replacementEnd: 2 }); await compose(cdp, '日本語'); await commit(cdp, '日本語');
    const s = await state(page);
    assert.deepEqual(span(s.edits.at(-1)), { before: '日本へ行く', start: 0, end: 2, text: '日本語', after: '日本語へ行く' });
    assert.equal(s.text, '日本語へ行く');
  });
  await scenario('Cancelling native conversion leaves no draft in the shared edit stream', async ({ page, cdp }) => {
    await compose(cdp, 'かな'); await compose(cdp, '仮名'); await compose(cdp, '');
    const s = await state(page); assert.deepEqual(s.edits, []); assert.equal(s.text, ''); assert.equal(s.composing, false);
  });
  await scenario('Candidate confirmation keys are untouched; a subsequent native Return is a command', async ({ page, cdp }) => {
    await compose(cdp, '日本');
    const accepted = await page.evaluate(() => document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(accepted, true); assert.deepEqual((await state(page)).commands, []);
    await commit(cdp, '日本'); await page.keyboard.press('Enter');
    const s = await state(page); assert.deepEqual(s.commands, ['insertParagraph']); assert.equal(s.edits.length, 1); assert.equal(s.text, '');
  });
  await scenario('Empty native context still exposes spatial Backspace and Delete intents', async ({ page }) => {
    await page.keyboard.press('Backspace'); await page.keyboard.press('Delete');
    const s = await state(page); assert.deepEqual(s.commands, ['deleteContentBackward', 'deleteContentForward']); assert.deepEqual(s.edits, []);
  });
  await scenario('UTF-16 target ranges preserve emoji and decomposed characters without normalization', async ({ page, cdp }) => {
    await commit(cdp, '🙂e\u0301'); await compose(cdp, '한', { replacementStart: 2, replacementEnd: 4 }); await commit(cdp, '한');
    const s = await state(page);
    assert.deepEqual(span(s.edits.at(-1)), { before: '🙂e\u0301', start: 2, end: 4, text: '한', after: '🙂한' });
  });
  await scenario('Navigation invalidates composition without rewriting its active native DOM', async ({ page, cdp }) => {
    await compose(cdp, '한'); const before = await page.locator('#input').textContent();
    await page.evaluate(() => bridge.cancel()); assert.equal(await page.locator('#input').textContent(), before);
    assert.equal((await state(page)).previews.at(-1).text, '');
    await commit(cdp, '한'); const s = await state(page);
    assert.deepEqual(s.edits, []); assert.equal(s.text, ''); assert.equal(s.invalidations, 1); assert.equal(s.composing, false);
    await compose(cdp, '새'); await commit(cdp, '새'); assert.equal((await state(page)).edits.at(-1).text, '새');
  });
  await scenario('Final input after compositionend completes the same transaction without timer heuristics', async ({ page }) => {
    await page.evaluate(() => {
      const el = document.getElementById('input');
      function mutate(text, composing) {
        const node = el.firstChild || el;
        const range = new StaticRange({ startContainer: node, startOffset: 0, endContainer: node, endOffset: node === el ? 0 : node.length });
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: text, isComposing: composing, targetRanges: [range], bubbles: true }));
        el.textContent = text; const selection = getSelection(); selection.selectAllChildren(el); selection.collapseToEnd();
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, isComposing: composing, bubbles: true }));
      }
      el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })); mutate('にほん', true);
      el.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
      if (edits.length) throw new Error('Unfinished DOM draft committed before final input');
      mutate('日本', false);
    });
    const s = await state(page); assert.deepEqual(s.edits.map(span), [{ before: '', start: 0, end: 0, text: '日本', after: '日本' }]); assert.equal(s.composing, false);
  });
  await scenario('Range-less edits are rejected explicitly instead of guessed from text differences', async ({ page, cdp }) => {
    await commit(cdp, 'ABC');
    await page.evaluate(() => { const el = document.getElementById('input'); el.textContent = 'AXC'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', data: 'X', bubbles: true })); });
    const s = await state(page); assert.equal(s.text, 'ABC'); assert.equal(s.edits.length, 1); assert.ok(s.unsupported.includes('missingNativeRange'));
  });
  await scenario('A draft with an unobserved composition start cannot fall through as committed input', async ({ page, cdp }) => {
    await page.evaluate(() => {
      const el = document.getElementById('input');
      const range = new StaticRange({ startContainer: el, startOffset: 0, endContainer: el, endOffset: 0 });
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '한', isComposing: true, targetRanges: [range], bubbles: true }));
      el.textContent = '한';
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '한', isComposing: true, bubbles: true }));
      if (edits.length) throw new Error('Unknown native draft became a shared edit');
      el.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    });
    const s = await state(page); assert.deepEqual(s.edits, []); assert.equal(s.text, ''); assert.ok(s.unsupported.includes('compositionLifecycle'));
    await compose(cdp, '새'); await commit(cdp, '새'); assert.equal((await state(page)).edits.at(-1).text, '새');
  });
  await scenario('Native clipboard paste inserts plain text through its supplied range', async ({ page, cdp }) => {
    await commit(cdp, 'A'); await page.evaluate(() => navigator.clipboard.writeText('中文\n한글'));
    await page.keyboard.press('Control+v'); await page.waitForFunction(() => document.getElementById('input').textContent === 'A中文\n한글');
    const s = await state(page); assert.deepEqual(span(s.edits.at(-1)), { before: 'A', start: 1, end: 1, text: '中文\n한글', after: 'A中文\n한글' });
    assert.equal(await page.locator('#input').locator('*').count(), 0);
  });
  console.log(JSON.stringify({ passed: passed.length, coverage: 'native Chromium ranges and explicit standard composition event-order variants' }));
} finally { await browser.close(); await app.close(); }
