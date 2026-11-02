import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { Budget, LIMITS, NetworkBudgets, ParticipantPolicy, PolicyError } from '../server/participant-policy.js';
import { Observer, contains, viewRectangle } from '../server/visibility.js';

function fixture(t, { x = 100, y = 100, network, isVisible, width = 2048, height = 1024 } = {}) {
  let time = 0, serial = 0;
  const world = new World({ width, height, now: () => 123 });
  t.after(() => world.db.close());
  const peer = { id: 'human-or-bot', x, y };
  const now = () => time;
  const policy = new ParticipantPolicy({ world, peer, now, network, isVisible });
  const write = (text, fields = {}) => policy.acceptWrite({ id: `write-${++serial}`, epoch: world.epoch,
    layout: 2, x: peer.x, y: peer.y, text, ...fields });
  const erase = (fields = {}) => policy.acceptErase({ id: `erase-${++serial}`, epoch: world.epoch,
    layout: 2, x: peer.x, y: peer.y, ...fields });
  const move = (x, y = peer.y) => policy.acceptMove({ x, y, epoch: world.epoch });
  return { world, peer, policy, write, erase, move, now, advance: ms => { time += ms; } };
}
const errorIs = (status, code) => error => error instanceof PolicyError && error.status === status && error.code === code;

test('budget refills by elapsed time and provides a usable retry delay', () => {
  let time = 0;
  const budget = new Budget({ rate: 12, capacity: 64, now: () => time });
  budget.spend(64);
  assert.throws(() => budget.spend(1), error => errorIs(429, 'RATE_LIMITED')(error) && error.retryAfterMs === 84);
  time = 84; budget.spend(1);
  const remaining = budget.tokens;
  time = 20; budget.refill();
  assert.equal(budget.tokens, remaining, 'a backwards wall clock cannot grant extra budget');
  assert.throws(() => budget.spend(65), errorIs(413, 'TOO_LARGE'));
});

test('64 graphemes form one atomic commit; subsequent input waits for the shared rate', t => {
  const f = fixture(t);
  const result = f.write('A'.repeat(64));
  assert.equal(result.cells.length, 64);
  assert.equal(f.world.seq, 1);
  const cursor = { ...f.peer };
  assert.throws(() => f.write('B'), errorIs(429, 'RATE_LIMITED'));
  assert.deepEqual(f.peer, cursor);
  assert.equal(f.world.seq, 1);
  f.advance(84); f.write('B');
  assert.equal(f.world.seq, 2, 'policy time advances independently of the fixed World timestamp');
});

test('a 20,000-character request and an expanded 68-space tab input make no partial changes', t => {
  const f = fixture(t);
  for (const text of ['A'.repeat(20_000), 'A'.repeat(65), '\t'.repeat(17)]) {
    assert.throws(() => f.write(text), errorIs(413, 'TOO_LARGE'));
    assert.equal(f.world.seq, 0);
    assert.equal(f.policy.write.tokens, 64);
    assert.deepEqual(f.peer, { id: 'human-or-bot', x: 100, y: 100 });
  }
});

test('CJK width and combining sequences consume graphemes, not bytes or columns', t => {
  const f = fixture(t);
  f.write('한'.repeat(32) + 'e\u0301'.repeat(32));
  assert.equal(f.peer.x, 196);
  assert.equal(f.policy.write.tokens, 0);
  assert.equal(f.world.getCell(164, 100).text, 'é');
  assert.equal(f.world.getCell(101, 100).width, 0);
});

test('native IME reconversion can replace its recent wide glyph atomically', t => {
  const f = fixture(t);
  f.write('ㅎ');
  const result = f.write('한', { x: 100, clear: [{ x: 100, y: 100 }, { x: 101, y: 100 }] });
  assert.equal(f.world.getCell(100, 100).text, '한');
  assert.equal(result.cells.length, 2);
  assert.equal(f.policy.write.tokens, 62, 'a two-column clear is one grapheme, not two actions');
  assert.equal(f.peer.x, 102);
});

test('recent native context is not an ownership lock against another participant', t => {
  const f = fixture(t);
  f.write('한');
  f.world.applyWrite({ author: 'other', id: 'other-write', epoch: f.world.epoch, x: 100, y: 100, text: '글' });
  f.write('국', { x: 100, clear: [{ x: 100, y: 100 }, { x: 101, y: 100 }] });
  assert.equal(f.world.getCell(100, 100).text, '국');
});

test('arbitrary visible writes and unrelated clear addresses are rejected before spending', t => {
  const f = fixture(t);
  assert.throws(() => f.write('A', { x: 130 }), errorIs(403, 'OUT_OF_REACH'));
  f.write('A');
  const before = f.policy.write.tokens;
  assert.throws(() => f.write('', { clear: [{ x: 110, y: 100 }] }), errorIs(403, 'OUT_OF_REACH'));
  assert.equal(f.policy.write.tokens, before);
  assert.equal(f.world.seq, 1);
});

test('navigation forgets reconversion context but preserves known writing origins', t => {
  const f = fixture(t);
  f.write('ABC');
  f.move(102);
  assert.throws(() => f.write('Z', { x: 100, clear: [{ x: 100, y: 100 }] }), errorIs(403, 'OUT_OF_REACH'));
  f.write('\n', { lineStartX: 100 });
  assert.deepEqual({ x: f.peer.x, y: f.peer.y }, { x: 100, y: 101 });
  assert.throws(() => f.write('\n', { lineStartX: 700 }), errorIs(403, 'OUT_OF_REACH'));
});

test('native caret synchronization preserves reconversion but only reaches accepted input edges', t => {
  const f = fixture(t);
  f.write('ABC');
  f.write('Z', { x: 101, clear: [{ x: 101, y: 100 }] });
  assert.equal(f.peer.x, 102);
  const moveBudget = f.policy.move.tokens;
  f.policy.acceptMove({ x: 103, y: 100, epoch: f.world.epoch, intent: 'native-caret' });
  assert.equal(f.policy.move.tokens, moveBudget - 1, 'native caret moves use the ordinary distance budget');
  f.write('X', { x: 100, clear: [{ x: 100, y: 100 }] });
  assert.equal(f.world.getCell(100, 100).text, 'X');
  assert.equal(f.world.getCell(101, 100).text, 'Z');
  assert.equal(f.world.getCell(102, 100).text, 'C');
  const before = f.policy.move.tokens;
  assert.throws(() => f.policy.acceptMove({ x: 110, y: 100, epoch: f.world.epoch, intent: 'native-caret' }), errorIs(403, 'OUT_OF_REACH'));
  assert.equal(f.policy.move.tokens, before);
  assert.equal(f.peer.x, 101);
  assert.throws(() => f.write('', { clear: [{ x: 103, y: 100 }] }), errorIs(403, 'OUT_OF_REACH'),
    'a remembered caret boundary is not an authorized clear address');
  f.move(105);
  assert.throws(() => f.policy.acceptMove({ x: 100, y: 100, epoch: f.world.epoch, intent: 'native-caret' }), errorIs(403, 'OUT_OF_REACH'));
});

test('native caret movement retains bounded known history even when its earlier edge is off-screen', t => {
  let visible = () => true;
  const f = fixture(t, { isVisible: (x, y) => visible(x, y) });
  for (let i = 0; i < 9; i++) { f.write('A'.repeat(64)); f.advance(6000); }
  assert.equal(f.policy.carets.size, LIMITS.recentAddresses);
  assert.equal(f.policy.recent.size, LIMITS.recentAddresses);
  assert.throws(() => f.policy.acceptMove({ x: 100, y: 100, epoch: f.world.epoch, intent: 'native-caret' }), errorIs(403, 'OUT_OF_REACH'));
  visible = x => x === f.peer.x;
  const tokens = f.policy.move.tokens;
  f.policy.acceptMove({ x: f.peer.x - 1, y: 100, epoch: f.world.epoch, intent: 'native-caret' });
  assert.equal(f.policy.move.tokens, tokens - 1, 'an off-screen known caret edge still costs ordinary movement');
  f.policy.acceptMove({ x: f.peer.x, y: 100, epoch: f.world.epoch, intent: 'native-caret' });
  assert.equal(f.policy.recent.size, LIMITS.recentAddresses, 'a native no-op caret sync retains context');
});

test('off-screen native edits use known input context without granting arbitrary write or clear addresses', t => {
  const f = fixture(t, { isVisible: (x, y) => x >= 100 && x < 104 && y === 100 });
  f.write('ABCDE');
  assert.equal(f.peer.x, 105);
  assert.equal(f.world.getCell(104, 100).text, 'E');
  const before = f.policy.write.tokens;
  assert.throws(() => f.write('Z', { x: 110 }), errorIs(403, 'OUT_OF_REACH'), 'unknown off-screen origins remain forbidden');
  assert.throws(() => f.write('', { x: 100, clear: [{ x: 110, y: 100 }] }), errorIs(403, 'OUT_OF_REACH'));
  assert.equal(f.policy.write.tokens, before);
  f.write('Z', { x: 104, clear: [{ x: 104, y: 100 }] });
  assert.equal(f.world.getCell(104, 100).text, 'Z');
  f.move(100);
  f.write('\n', { lineStartX: 100 });
  assert.deepEqual({ x: f.peer.x, y: f.peer.y }, { x: 100, y: 101 });
  assert.equal(f.world.seq, 3);
});

test('49-CJK reconversion reaches prior native context while observation stays at the final bounded view', t => {
  const view = { cols: 20, rows: 4 };
  let f;
  f = fixture(t, { isVisible: (x, y) => contains(viewRectangle(f.world, f.peer, view), x, y, f.world) });
  f.world.applyWrite({ author: 'other', id: 'hidden-canary', epoch: f.world.epoch, x: 1000, y: 100, text: 'SECRET' });
  const observer = new Observer({ world: f.world, peer: f.peer, view, charge: cost => f.policy.acceptObservation(cost) });
  const initial = observer.read([f.peer]);
  f.write('한'.repeat(49));
  const first = observer.read([f.peer], { since: initial.revision });
  assert.equal(f.peer.x, 198);
  assert.equal(f.policy.isVisible(100, 100), false, 'the first glyph is now outside the centered screen');
  assert.throws(() => f.write('글'.repeat(49), { x: 100,
    clear: Array.from({ length: 98 }, (_, i) => ({ x: 100 + i, y: 100 })) }), errorIs(429, 'RATE_LIMITED'));
  assert.equal(f.world.getCell(100, 100).text, '한', 'a blocked reconversion has no partial erase');
  f.advance(5000);
  f.write('글'.repeat(49), { x: 100,
    clear: Array.from({ length: 98 }, (_, i) => ({ x: 100 + i, y: 100 })) });
  assert.equal(f.policy.write.tokens, 15, '49 wide glyphs consume49 graphemes, including the replaced range');
  assert.equal(f.world.getCell(100, 100).text, '글');
  assert.equal(f.world.getCell(196, 100).text, '글');
  const observation = observer.read([f.peer], { since: first.revision });
  assert.ok(observation.cells.length > 0);
  assert.ok(observation.cells.every(cell => contains(observation.view, cell.x, cell.y, f.world)));
  assert.ok(!observation.cells.some(cell => cell.x === 100 || cell.x >= 1000), 'neither old off-screen context nor distant canary is returned');
  f.move(300);
  assert.throws(() => f.write('X', { x: 100 }), errorIs(403, 'OUT_OF_REACH'), 'ordinary navigation clears the old native capability');
});

test('64 wide glyphs can be cleared through 128 recent addresses at a cost of 64', t => {
  const f = fixture(t);
  f.write('한'.repeat(64));
  f.advance(6000);
  const clear = Array.from({ length: 128 }, (_, i) => ({ x: 100 + i, y: 100 }));
  const result = f.write('', { x: 100, clear });
  assert.equal(result.cells.length, 128);
  assert.equal(f.policy.write.tokens, 0);
  assert.equal(f.policy.recent.size, 0);
  assert.equal(f.world.snapshot().cells.length, 0);
});

test('duplicate mutation IDs do not spend, rewind the cursor, or require the old epoch', t => {
  const f = fixture(t);
  f.write('A', { id: 'same' });
  f.move(105);
  const before = f.policy.write.tokens;
  const result = f.write('B', { id: 'same', x: 999, epoch: -1 });
  assert.equal(result.duplicate, true);
  assert.equal(f.peer.x, 105);
  assert.equal(f.policy.write.tokens, before);
  assert.equal(f.world.seq, 1);
});

test('erase reaches only the cursor or immediately previous grapheme with explicit backspace intent', t => {
  const f = fixture(t);
  f.write('A한');
  assert.throws(() => f.erase({ x: 100, intent: 'backspace' }), errorIs(403, 'OUT_OF_REACH'));
  assert.throws(() => f.erase({ x: 101 }), errorIs(403, 'OUT_OF_REACH'));
  f.erase({ x: 101, intent: 'backspace' });
  assert.equal(f.peer.x, 101);
  assert.equal(f.world.getCell(101, 100).text, '');
  assert.equal(f.world.getCell(102, 100).text, '');
  assert.equal(f.world.getCell(100, 100).text, 'A');
  f.erase({ x: 100, intent: 'backspace' });
  assert.equal(f.peer.x, 100);
  assert.equal(f.policy.write.tokens, 60);
});

test('movement uses toroidal distance and an arbitrary relocation spends a full burst', t => {
  const f = fixture(t, { x: 2047, y: 0 });
  assert.equal(f.move(0).cost, 1);
  assert.throws(() => f.move(1024, 512), errorIs(429, 'RATE_LIMITED'));
  assert.equal(f.peer.x, 0);
  f.advance(4);
  assert.equal(f.move(1024, 512).cost, 640);
  assert.throws(() => f.move(0, 0), errorIs(429, 'RATE_LIMITED'));
});

test('network effect budget survives fresh sessions and failed preflight spends no actor tokens', t => {
  const network = new NetworkBudgets({ now: () => 0 }).get('shared-address');
  const first = fixture(t, { network }), second = fixture(t, { network }), third = fixture(t, { network });
  first.write('A'.repeat(64)); second.write('B'.repeat(64));
  assert.throws(() => third.write('C'), errorIs(429, 'RATE_LIMITED'));
  assert.equal(third.policy.write.tokens, 64);
  assert.equal(third.world.seq, 0);
});

test('observation charges newly exposed addresses with atomic actor and network budgets', t => {
  const network = new NetworkBudgets({ now: () => 0 }).get('shared-address');
  const first = fixture(t, { network }), second = fixture(t, { network }), third = fixture(t, { network });
  first.policy.acceptObservation(49152); second.policy.acceptObservation(49152);
  third.policy.acceptObservation(0);
  assert.throws(() => third.policy.acceptObservation(1), errorIs(429, 'RATE_LIMITED'));
  assert.equal(third.policy.read.tokens, LIMITS.read.burst);
  assert.throws(() => first.policy.acceptObservation(1), errorIs(429, 'RATE_LIMITED'));
  assert.throws(() => first.policy.acceptObservation(-1), TypeError);
});

test('request budgets apply across transports and cannot be multiplied with fresh actors', t => {
  const network = new NetworkBudgets({ now: () => 0 }).get('shared-address');
  const first = fixture(t, { network }), second = fixture(t, { network }), third = fixture(t, { network });
  for (let i = 0; i < 160; i++) { first.policy.acceptRequest(); second.policy.acceptRequest(); }
  assert.throws(() => third.policy.acceptRequest(), errorIs(429, 'RATE_LIMITED'));
  assert.equal(third.policy.request.tokens, 160);
});

test('an internally precharged transport request skips only its network charge, never actor throttling', t => {
  const network = new NetworkBudgets({ now: () => 0 }).get('shared-address');
  const f = fixture(t, { network });
  network.request.spend(1);
  f.policy.acceptRequest({ networkCharged: true });
  assert.equal(network.request.tokens, 319, 'the adapter and participant together count one network request');
  assert.equal(f.policy.request.tokens, 159);
  f.policy.acceptRequest();
  assert.equal(network.request.tokens, 318, 'ordinary requests retain their network charge');
  assert.equal(f.policy.request.tokens, 158);
  network.request.spend(318);
  assert.throws(() => f.policy.acceptRequest(), errorIs(429, 'RATE_LIMITED'));
  assert.throws(() => f.policy.acceptRequest({ networkCharged: false }), errorIs(429, 'RATE_LIMITED'));
  assert.throws(() => f.policy.acceptRequest({ networkCharged: 'true' }), errorIs(429, 'RATE_LIMITED'));
  assert.equal(f.policy.request.tokens, 158, 'network rejection does not spend actor tokens');
  for (let i = 0; i < 158; i++) f.policy.acceptRequest({ networkCharged: true });
  assert.equal(network.request.tokens, 0);
  assert.throws(() => f.policy.acceptRequest({ networkCharged: true }), errorIs(429, 'RATE_LIMITED'));
});

test('disconnects preserve network budgets and only inactive entries expire after ten minutes', () => {
  let time = 0;
  const networks = new NetworkBudgets({ now: () => time, idleMs: 1, maxEntries: 2 });
  const entry = networks.acquire('one');
  entry.write.spend(128); networks.release('one');
  assert.equal(networks.acquire('one'), entry);
  assert.throws(() => entry.write.spend(1), errorIs(429, 'RATE_LIMITED'));
  networks.acquire('two');
  assert.throws(() => networks.acquire('three'), errorIs(503, 'SERVER_BUSY'));
  networks.release('one'); time = 599999; networks.prune();
  assert.equal(networks.entries.size, 2);
  time = 600001; networks.prune();
  assert.equal(networks.entries.has('one'), false);
  assert.equal(networks.entries.has('two'), true, 'active sessions retain their shared budget');
  networks.acquire('three');
});

test('same-address session and creation limits return retryable 429', () => {
  let time = 0;
  const networks = new NetworkBudgets({ now: () => time });
  for (let i = 0; i < 8; i++) networks.acquire('one');
  assert.throws(() => networks.acquire('one'), errorIs(429, 'TOO_MANY_SESSIONS'));
  networks.release('one');
  assert.throws(() => networks.acquire('one'), errorIs(429, 'RATE_LIMITED'));
  time = 1000; networks.acquire('one');
  assert.equal(networks.get('one').sessions, 8);
});

test('invalid native edits and stale epochs cannot mutate or consume effect budget', t => {
  const f = fixture(t);
  for (const fields of [{ text: 42 }, { text: '\0' }, { clear: {} }, { x: 0.5 }, { epoch: 0 }]) {
    assert.throws(() => f.write('A', fields), error => error instanceof PolicyError);
    assert.equal(f.world.seq, 0);
    assert.equal(f.policy.write.tokens, 64);
  }
  f.write('A', { author: 'forged-author' });
  assert.equal(f.world.getCell(100, 100).author, f.peer.id);
});
