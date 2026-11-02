import test from 'node:test';
import assert from 'node:assert/strict';
import { graphemeWidth, UNICODE_WIDTH_VERSION } from '../shared/width.js';

test('display width follows Unicode EAW rather than bytes or chosen font', () => {
  assert.equal(UNICODE_WIDTH_VERSION, '17.0.0');
  for (const text of ['A', 'z', '7', ' ', 'é', 'Ω', '·', '€', 'ｶ', '｡']) {
    assert.equal(graphemeWidth(text), 1, `narrow or ambiguous ${text}`);
  }
  for (const text of ['한', '글', 'ㄱ', '가', '漢', '字', 'あ', 'カ', 'Ａ', '！', '　', '𠀀', '☰']) {
    assert.equal(graphemeWidth(text), 2, `wide or fullwidth ${text}`);
  }
});

test('combining accents and Korean decomposition do not add columns', () => {
  assert.equal(graphemeWidth('e\u0301'), 1);
  assert.equal(graphemeWidth('A\u0301\u0323'), 1);
  assert.equal(graphemeWidth('한'), 2);
  assert.equal(graphemeWidth('か\u3099'), 2);
  assert.equal(graphemeWidth('\u0301'), 1, 'isolated combining mark remains addressable');
  assert.equal(graphemeWidth('\u200d'), 1, 'isolated format marker remains addressable');
});

test('emoji presentation, flags, keycaps and joined emoji take two columns', () => {
  for (const text of ['😀', '👨‍👩‍👧‍👦', '👩🏽‍💻', '🇰🇷', '1️⃣', '#⃣', '©️', '☀️', '❤️', '👁️‍🗨️']) {
    assert.equal(graphemeWidth(text), 2, text);
  }
  for (const text of ['©', '©︎', '☀', '☀︎', '❤', '❤︎', 'A️']) {
    assert.equal(graphemeWidth(text), 1, `text presentation ${text}`);
  }
  assert.equal(graphemeWidth('😀︎'), 2, 'VS15 does not erase the EAW W classification');
});

test('width data handles Unicode 17 additions without host Unicode property regexes', () => {
  // FACE WITH DISTORTED EYES and Unicode CJK extension J.
  assert.equal(graphemeWidth(String.fromCodePoint(0x1faea)), 2);
  assert.equal(graphemeWidth(String.fromCodePoint(0x323b0)), 2);
  assert.equal(graphemeWidth('क\u093f'), 1, 'spacing combining vowel does not allocate a second base');
});
