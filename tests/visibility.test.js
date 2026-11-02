import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { validateView, viewRectangle, contains, visibleCells, visiblePeers, Observer } from '../server/visibility.js';

const peer = (id, x, y) => ({ id, x, y, name: `visitor-${id}`, color: '#123456', privateField: 'not public' });
function fixture(t, options = {}) {
  const world = new World({ now: () => 1000, ...options });
  t.after(() => world.close());
  let id = 0;
  const write = (text, x, y) => world.applyWrite({ author: 'writer', id: `write-${++id}`, epoch: world.epoch, text, x, y });
  return { world, write };
}
const at = (cells, x, y) => cells.find(cell => cell.x === x && cell.y === y);
const keys = cells => cells.map(cell => `${cell.x},${cell.y}`).sort();

test('view limits are common, bounded, strict integers and independent of client labels', () => {
  assert.deepEqual(validateView(), { cols: 80, rows: 24 });
  assert.deepEqual(validateView({ cols: 192, rows: 128 }), { cols: 192, rows: 128 });
  assert.equal(VIEW_LIMITS.maxArea, 24576);
  assert.equal(Object.isFrozen(VIEW_LIMITS), true);
  for (const value of [null, [], '80x24', { cols: 0 }, { rows: -1 }, { cols: 1.5 }, { cols: '80' },
    { cols: Infinity }, { rows: 129 }, { cols: 321 }, { cols: 320, rows: 128 }, { x: 0 }, { role: 'human' }]) {
    assert.throws(() => validateView(value), error => error.code === 'BAD_VIEW' && error.status === 400, JSON.stringify(value));
  }
});

test('a view is attached to the cursor, clips distant canaries and sanitizes cells and peers', t => {
  const { world, write } = fixture(t);
  write('A', 64, 32); write('HIDDEN-CANARY', 1, 1);
  const self = peer('self', 64, 32), near = peer('near', 65, 32), far = peer('far', 1, 1);
  const view = { cols: 8, rows: 4 }, rectangle = viewRectangle(world, self, view);
  assert.deepEqual(rectangle, { x: 60, y: 30, cols: 8, rows: 4 });
  assert.equal(contains(rectangle, 64, 32, world), true);
  assert.equal(contains(rectangle, 1, 1, world), false);
  const cells = visibleCells(world, self, view);
  assert.equal(cells.length, 1); assert.equal(cells[0].text, 'A');
  assert.deepEqual(Object.keys(cells[0]).sort(), ['leadX', 'text', 'version', 'width', 'x', 'y']);
  const people = visiblePeers(world, self, view, [far, near, self]);
  assert.deepEqual(people.map(item => item.id), ['self', 'near']);
  assert.deepEqual(Object.keys(people[0]).sort(), ['color', 'id', 'name', 'x', 'y']);
  assert.ok(!JSON.stringify({ cells, people }).includes('CANARY'));
  assert.ok(!JSON.stringify({ cells, people }).includes('privateField'));
});

test('toroidal views cross both seams without duplicate addresses or a whole-world scan', t => {
  const { world, write } = fixture(t, { width: 32, height: 16 });
  write('A', 31, 15); write('B', 0, 0); write('Z', 8, 8);
  const self = peer('self', 0, 0), request = { cols: 4, rows: 4 };
  const rectangle = viewRectangle(world, self, request);
  assert.deepEqual(rectangle, { x: 30, y: 14, cols: 4, rows: 4 });
  assert.equal(contains(rectangle, -1, -1, world), true);
  assert.deepEqual(keys(visibleCells(world, self, request)), ['0,0', '31,15']);
  const larger = visibleCells(world, self, { cols: 80, rows: 24 });
  assert.equal(larger.length, 3); assert.equal(new Set(keys(larger)).size, 3);
  assert.deepEqual(viewRectangle(world, self, { cols: 80, rows: 24 }), { x: 16, y: 8, cols: 32, rows: 16 });
  const getCell = world.getCell.bind(world); let reads = 0;
  world.getCell = (...args) => { reads++; return getCell(...args); };
  visibleCells(world, self, request);
  assert.equal(reads, 16, 'bounded address iteration does not inspect remote cells');
});

test('visible halves include only their complete wide glyph at an ordinary edge and a torus seam', t => {
  const { world, write } = fixture(t, { width: 32, height: 16 });
  write('한', 9, 8); write('中', 13, 8); write('語', 31, 1);
  write('PRIVATE', 20, 8);
  const inside = visibleCells(world, peer('self', 12, 8), { cols: 4, rows: 1 });
  assert.deepEqual(keys(inside), ['10,8', '13,8', '14,8', '9,8']);
  assert.equal(at(inside, 9, 8).text, '한');
  assert.equal(at(inside, 10, 8).leadX, 9);
  assert.equal(at(inside, 14, 8).version, at(inside, 13, 8).version);
  const seam = visibleCells(world, peer('self', 0, 1), { cols: 1, rows: 1 });
  assert.deepEqual(keys(seam), ['0,1', '31,1']);
  assert.equal(at(seam, 31, 1).text, '語');
  assert.ok(!JSON.stringify(inside).includes('PRIVATE'));
});

test('a malformed continuation cannot disclose a distant unrelated glyph', t => {
  const { world, write } = fixture(t);
  write('秘', 100, 8);
  const head = world.getCell(100, 8);
  world.cells.set('5,8', { x: 5, y: 8, text: '', width: 0, leadX: 100, version: head.version });
  const cells = visibleCells(world, peer('self', 5, 8), { cols: 1, rows: 1 });
  assert.deepEqual(cells, []);
});

test('observation revisions change only for visible state and matching revisions receive deltas', t => {
  const { world, write } = fixture(t);
  const self = peer('self', 64, 32), other = peer('other', 2, 2);
  const observer = new Observer({ world, peer: self, view: { cols: 8, rows: 4 } });
  write('A', 64, 32);
  const first = observer.read([self, other]);
  assert.equal(first.revision, 1); assert.equal(first.reset, true); assert.equal(first.cells.length, 1);
  write('SECRET', 2, 2); other.x = 3;
  const noChange = observer.read([self, other], { since: first.revision });
  assert.equal(noChange.revision, 1); assert.equal(noChange.reset, false);
  assert.deepEqual(noChange.cells, []); assert.deepEqual(noChange.forget, []);
  write('B', 65, 32);
  const changed = observer.read([self, other], { since: 1 });
  assert.equal(changed.revision, 2); assert.equal(changed.reset, false);
  assert.deepEqual(changed.cells.map(cell => cell.text), ['B']);
  const repeated = observer.read([self, other], { since: 2 });
  assert.equal(repeated.revision, 2); assert.deepEqual(repeated.cells, []);
  assert.equal(Object.hasOwn(changed, 'seq'), false);
});

test('delta forget removes departed and deleted glyphs while a stale revision returns only the current view', t => {
  const { world, write } = fixture(t);
  const self = peer('self', 64, 32), observer = new Observer({ world, peer: self, view: { cols: 4, rows: 2 } });
  write('OLD', 63, 32); write('NEW', 90, 40);
  const first = observer.read();
  self.x = 91; self.y = 40;
  const moved = observer.read([], { since: first.revision });
  assert.equal(moved.reset, false); assert.deepEqual(keys(moved.forget), ['63,32', '64,32', '65,32']);
  assert.equal(moved.cells.map(cell => cell.text).join(''), 'NEW');
  const stale = observer.read([], { since: 1 });
  assert.equal(stale.reset, true); assert.deepEqual(stale.forget, []);
  assert.equal(stale.cells.map(cell => cell.text).join(''), 'NEW');
  assert.ok(!JSON.stringify(stale).includes('OLD'));
  world.erase({ author: 'writer', id: 'erase', epoch: world.epoch, x: 91, y: 40 });
  const erased = observer.read([], { since: stale.revision });
  assert.deepEqual(erased.forget, [{ x: 91, y: 40 }]); assert.deepEqual(erased.cells, []);
});

test('resize and invalid revisions reset to current scope; resizing a view never grants arbitrary origins', t => {
  const { world, write } = fixture(t);
  write('A', 64, 32); write('HIDDEN', 4, 4);
  const self = peer('self', 64, 32), observer = new Observer({ world, peer: self, view: { cols: 8, rows: 4 } });
  const first = observer.read();
  observer.setView({ cols: 6, rows: 2 });
  const smaller = observer.read([], { since: first.revision });
  assert.equal(smaller.reset, false); assert.equal(smaller.view.cols, 6);
  assert.throws(() => observer.setView({ cols: 6, rows: 2, x: 4, y: 4 }), error => error.code === 'BAD_VIEW');
  assert.deepEqual(observer.view, { cols: 6, rows: 2 });
  world.resize(256, 128, [self]);
  const resized = observer.read([], { since: smaller.revision });
  assert.equal(resized.reset, true); assert.equal(resized.revision, smaller.revision + 1);
  for (const since of [-1, 999999, NaN, '3']) {
    const answer = observer.read([], { since });
    assert.equal(answer.reset, true); assert.deepEqual(answer.cells.map(cell => cell.text), ['A']);
    assert.equal(answer.revision, resized.revision);
  }
});

test('one final read exposes no intermediate turn locations and response mutation cannot change the baseline', t => {
  const { world, write } = fixture(t);
  write('A', 64, 32); write('SECRET', 2, 2);
  const self = peer('self', 64, 32), observer = new Observer({ world, peer: self, view: { cols: 8, rows: 4 } });
  const first = observer.read();
  self.x = 2; self.y = 2;
  self.x = 64; self.y = 32;
  const final = observer.read([], { since: first.revision });
  assert.equal(final.revision, first.revision); assert.deepEqual(final.cells, []);
  const reset = observer.read([], { force: true });
  reset.cells[0].text = 'spoofed'; reset.peers[0].x = 1; reset.view.x = 1;
  const next = observer.read([], { since: reset.revision });
  assert.equal(next.revision, reset.revision); assert.deepEqual(next.cells, []);
  assert.equal(next.peers[0].x, 64); assert.equal(next.view.x, 60);
});

test('observation charges new addresses including blank space, with toroidal overlap and no reset surcharge', t => {
  const { world, write } = fixture(t, { width: 32, height: 16 });
  const costs = [], self = peer('self', 0, 0);
  const observer = new Observer({ world, peer: self, view: { cols: 4, rows: 4 }, charge: cost => costs.push(cost) });
  const first = observer.read();
  assert.deepEqual(costs, [16]);
  self.x = 1;
  const moved = observer.read([], { since: first.revision });
  assert.equal(costs.at(-1), 4, 'one new column across the seam');
  observer.read([], { since: -1, force: true });
  assert.equal(costs.at(-1), 0, 'reset retransmits only already observed addresses');
  write('A', 1, 0);
  observer.read([], { since: moved.revision });
  assert.equal(costs.at(-1), 0, 'a visible update does not expand perception');
  observer.setView({ cols: 2, rows: 2 });
  observer.read();
  assert.equal(costs.at(-1), 0, 'shrinking a view adds no addresses');
  observer.setView({ cols: 4, rows: 4 });
  observer.read();
  assert.equal(costs.at(-1), 12, 'only the bounded previous view is retained');
  world.resize(64, 32, [self]);
  observer.read();
  assert.equal(costs.at(-1), 16, 'world topology changes require a fresh observation');
});

test('CJK closure addresses are charged once, including newly visible halves on an unchanged view', t => {
  const { world, write } = fixture(t, { width: 32, height: 16 });
  const costs = [], self = peer('self', 0, 1);
  const observer = new Observer({ world, peer: self, view: { cols: 1, rows: 1 }, charge: cost => costs.push(cost) });
  const first = observer.read();
  assert.equal(costs.at(-1), 1);
  write('語', 31, 1);
  const wide = observer.read([], { since: first.revision });
  assert.deepEqual(keys(wide.cells), ['0,1', '31,1']);
  assert.equal(costs.at(-1), 1, 'new head outside the primary rectangle is an additional address');
  self.x = 31;
  observer.read([], { since: wide.revision });
  assert.equal(costs.at(-1), 0, 'both pair addresses were already visible');
});

test('a rejected observation preserves its previous baseline and revision until an accepted retry', t => {
  const { world, write } = fixture(t);
  write('A', 64, 32); write('B', 80, 32);
  let rejected = true;
  const costs = [], self = peer('self', 64, 32);
  const observer = new Observer({ world, peer: self, view: { cols: 4, rows: 2 }, charge: cost => {
    costs.push(cost);
    if (rejected && cost) throw Object.assign(new Error('Observation limit'), { status: 429 });
  } });
  assert.throws(() => observer.read(), error => error.status === 429);
  assert.equal(observer.revision, 0); assert.equal(observer.last, null);
  rejected = false;
  const first = observer.read();
  assert.deepEqual(costs, [8, 8]);
  const baseline = observer.last;
  self.x = 80; rejected = true;
  assert.throws(() => observer.read([], { since: first.revision }), error => error.status === 429);
  assert.equal(observer.revision, first.revision); assert.equal(observer.last, baseline);
  rejected = false;
  const retry = observer.read([], { since: first.revision });
  assert.equal(retry.reset, false); assert.equal(retry.revision, first.revision + 1);
  assert.deepEqual(retry.forget, [{ x: 64, y: 32 }]);
  assert.deepEqual(retry.cells.map(cell => cell.text), ['B']);
  assert.deepEqual(costs, [8, 8, 8, 8]);
});
