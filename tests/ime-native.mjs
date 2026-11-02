// Native Chromium ranges plus explicit mobile event variants. This is not an
// Android/iOS hardware-keyboard acceptance claim.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const app = createTextworld({ storagePath: ':memory:' });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const results = [];
async function scenario(name, run) {
  const page = await browser.newPage();
  await page.route('**/ime-harness', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="input"></textarea>' }));
  try {
    await page.goto(`http://127.0.0.1:${port}/ime-harness`);
    await page.evaluate(async () => {
      const { createNativeInput } = await import('/native-input.js');
      const input = document.getElementById('input');
      window.result = { committed: '', edits: [], previews: [], commands: [], unsupported: [], invalidated: 0 };
      const split = text => [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)].map(x => x.segment);
      window.bridge = createNativeInput(input, {
        onEdit(edit) {
          result.edits.push(edit);
          const before = split(result.committed);
          result.committed = before.slice(0, before.length - edit.remove).join('') + edit.text;
        },
        onPreedit(text, { remove }) { result.previews.push({ text, remove }); },
        onCommand(type) { result.commands.push(type); },
        onUnsupported(type) { result.unsupported.push(type); },
        onInvalidated() { result.invalidated++; },
      });
      input.addEventListener('keydown', event => {
        if (bridge.handleKeydown(event)) return;
        const type = { Enter: 'insertParagraph', Backspace: 'deleteContentBackward', Delete: 'deleteContentForward' }[event.key];
        if (type) { event.preventDefault(); bridge.command(type); }
      });
      input.focus();
    });
    const cdp = await page.context().newCDPSession(page);
    await run({ page, cdp });
    results.push(name); console.log(`PASS ${name}`);
  } finally { await page.close(); }
}
const state = page => page.evaluate(() => ({ ...result, value: input.value, composing: bridge.composing, preedit: bridge.preedit }));

try {
  await scenario('Native IME can replace its retained provisional jamo instead of appending another cell', async ({ page, cdp }) => {
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    assert.equal((await state(page)).value, 'ㅎ');
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    assert.equal((await state(page)).committed, 'ㅎ');
    assert.deepEqual((await state(page)).previews.at(-1), { text: '한', remove: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    const s = await state(page);
    assert.equal(s.committed, '한'); assert.equal(s.value, '한'); assert.equal(s.composing, false);
    assert.deepEqual(s.edits, [{ remove: 0, text: 'ㅎ' }, { remove: 1, text: '한' }]);
  });
  await scenario('Consecutive native Korean syllables retain prefix context without replaying it', async ({ page, cdp }) => {
    for (const syllables of [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]) {
      for (const text of syllables) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.insertText', { text: syllables.at(-1) });
    }
    await cdp.send('Input.insertText', { text: ' ABC' });
    const s = await state(page);
    assert.equal(s.committed, '한글 ABC'); assert.equal(s.value, '한글 ABC');
    assert.deepEqual(s.edits, [{ remove: 0, text: '한' }, { remove: 0, text: '글' }, { remove: 0, text: ' ABC' }]);
    assert.ok(s.previews.some(x => x.text === '글' && x.remove === 0));
  });
  await scenario('Composition-specific input without isComposing remains local until explicit final input', async ({ page }) => {
    await page.evaluate(() => {
      for (const text of ['ㅎ', '하', '한']) {
        input.value = text;
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text }));
      }
    });
    assert.equal((await state(page)).committed, ''); assert.equal((await state(page)).preedit, '한');
    await page.evaluate(() => input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '한' })));
    assert.equal((await state(page)).committed, '한'); assert.equal((await state(page)).composing, false);
  });
  await scenario('Final composition input in a later task is deduplicated without leaving a phantom session', async ({ page, cdp }) => {
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    await page.evaluate(() => input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '한' })));
    assert.equal((await state(page)).composing, false); assert.equal((await state(page)).edits.length, 1);
    await page.keyboard.press('Enter');
    assert.deepEqual((await state(page)).commands, ['insertParagraph']);
    await cdp.send('Input.insertText', { text: '한' });
    assert.equal((await state(page)).committed, '한한');
  });
  await scenario('Enter confirming IME is distinct from the following Return command', async ({ page, cdp }) => {
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await page.evaluate(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true })));
    await cdp.send('Input.insertText', { text: '한' });
    await page.evaluate(() => input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true })));
    assert.deepEqual((await state(page)).commands, []);
    await page.keyboard.press('Enter');
    assert.deepEqual((await state(page)).commands, ['insertParagraph']);
  });
  await scenario('Map cancellation discards late native completion and allows a fresh composition', async ({ page, cdp }) => {
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await page.evaluate(() => bridge.cancel());
    await cdp.send('Input.insertText', { text: '한' });
    assert.equal((await state(page)).committed, '');
    await cdp.send('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '글' });
    assert.equal((await state(page)).committed, '글');
  });
  await scenario('Snapshot reset suppresses a late companion whose inputType is unavailable', async ({ page }) => {
    await page.evaluate(() => {
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.value = '한';
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '한', isComposing: true }));
      bridge.reset();
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
      input.value = '한';
      input.dispatchEvent(new InputEvent('input', { inputType: '', data: '한' }));
    });
    assert.equal((await state(page)).committed, ''); assert.equal((await state(page)).value, '');
    await page.keyboard.type('A');
    assert.equal((await state(page)).committed, 'A');
  });
  await scenario('Native replacement inside a retained string cannot insert and shift spatial content', async ({ page, cdp }) => {
    await cdp.send('Input.insertText', { text: 'ABC' });
    await cdp.send('Input.imeSetComposition', { text: 'X', selectionStart: 1, selectionEnd: 1, replacementStart: 1, replacementEnd: 2 });
    await cdp.send('Input.insertText', { text: 'X' });
    const s = await state(page);
    assert.equal(s.committed, 'ABC'); assert.ok(s.unsupported.includes('insertReplacementText'));
  });
  await scenario('Native trailing replacement counts a retained tab as four spatial steps', async ({ page, cdp }) => {
    await cdp.send('Input.insertText', { text: 'A\t' });
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1, replacementStart: 1, replacementEnd: 2 });
    await cdp.send('Input.insertText', { text: '한' });
    assert.deepEqual((await state(page)).edits.at(-1), { remove: 4, text: '한' });
    assert.equal((await state(page)).committed, 'A한');
  });
  console.log(JSON.stringify({ passed: results.length, coverage: 'native Chromium ranges plus explicit mobile event variants' }));
} finally { await browser.close(); await app.close(); }
