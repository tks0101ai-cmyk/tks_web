const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require.resolve('./motion.js'), 'utf8');

function setup(html, reduced = false, supported = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const animations = [];
  const timers = [];
  const frames = new Map();
  let nextFrame = 0;
  let changed;
  const media = { matches: reduced, addEventListener: (_, callback) => { changed = callback; } };
  w.matchMedia = () => media;
  w.CSS = { supports: () => true };
  w.Element.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  if (supported) w.Element.prototype.animate = function (keyframes, options) {
    const record = { element: this, keyframes, options, cancelled: false };
    animations.push(record);
    return { finished: new Promise(() => {}), cancel() { record.cancelled = true; } };
  };
  w.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  w.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.eval(source);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return {
    dom, w, animations, timers,
    reduce() { media.matches = true; changed(); },
    frame(time) { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(time)); },
    async rescan() {
      w.TKSMotion.refresh();
      const timer = timers.find(item => item.delay === 80);
      if (timer) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
      await Promise.resolve();
    }
  };
}

test('heading letters stagger 12ms while keeping subtitle node, text, and listener intact', () => {
  const ctx = setup('<div class="section-head"><h2>AB <span class="section-note">Note</span></h2></div>');
  const heading = ctx.w.document.querySelector('h2');
  const note = heading.querySelector('.section-note');
  assert.equal(heading.textContent, 'AB Note');
  assert.deepEqual(ctx.animations.filter(a => a.options.duration === 260).map(a => a.options.delay), [0, 12]);
  assert.match(ctx.animations[0].keyframes[0].transform, /translateY\(-20px\)/);
  assert.equal(heading.querySelector('.section-note'), note);
  ctx.timers.find(timer => timer.delay > 260).callback();
  assert.equal(heading.textContent, 'AB Note');
  assert.equal(heading.querySelector('.section-note'), note);
  ctx.dom.window.close();
});

test('cards flip with 30ms stagger and do not replay on refresh or row replacement', async () => {
  const ctx = setup('<div><div class="kpi-card"></div><div class="kpi-card"></div></div><main><table><tbody><tr><td>A</td></tr></tbody></table></main>');
  assert.deepEqual(ctx.animations.filter(a => a.options.duration === 300).map(a => a.options.delay), [0, 30]);
  assert.match(ctx.animations[0].keyframes[0].transform, /rotateY\(-90deg\)/);
  const before = ctx.animations.length;
  ctx.w.document.querySelector('tbody').innerHTML = '<tr><td>B</td></tr>';
  await ctx.rescan();
  assert.equal(ctx.animations.length, before);
  ctx.dom.window.close();
});

test('loading placeholders defer row entrance until data arrives', async () => {
  const ctx = setup('<main><table><tbody><tr><td colspan="3">Loading</td></tr></tbody></table></main>');
  assert.equal(ctx.animations.length, 0);
  ctx.w.document.querySelector('tbody').innerHTML = '<tr><td>Data</td><td>42</td></tr><tr><td>More</td><td>21</td></tr>';
  await ctx.rescan();
  assert.deepEqual(ctx.animations.map(a => a.options.delay), [0, 15]);
  ctx.dom.window.close();
});

test('countup leaves financial source text unchanged and restores visual style on live data update', () => {
  const ctx = setup('<div class="kpi-card"><div class="value" style="color:rgb(1, 2, 3)">1.234.567₫</div></div>');
  const value = ctx.w.document.querySelector('.value');
  ctx.frame(0);
  ctx.frame(200);
  assert.equal(value.textContent, '1.234.567₫');
  assert.notEqual(value.getAttribute('data-tks-count-display'), '1.234.567₫');
  value.textContent = '2.000₫';
  ctx.frame(210);
  assert.equal(value.textContent, '2.000₫');
  assert.equal(value.classList.contains('tks-motion-count'), false);
  assert.equal(value.style.color, 'rgb(1, 2, 3)');
  ctx.dom.window.close();
});

test('countup finishes with exact original display; zero placeholders permit first loaded value', async () => {
  const ctx = setup('<div class="kpi-stat"><div class="val">0</div></div>');
  const value = ctx.w.document.querySelector('.val');
  value.textContent = '1.234,50%';
  await ctx.rescan();
  ctx.frame(0);
  ctx.frame(400);
  assert.equal(value.textContent, '1.234,50%');
  assert.equal(value.hasAttribute('data-tks-count-display'), false);
  ctx.dom.window.close();
});

test('dashboard en-US money and decimal ratios animate without changing source data', () => {
  const ctx = setup('<div data-motion-count>20,947,817,562₫</div><div data-motion-count>5.2%</div><div data-motion-count data-motion-locale="vi-VN">1.234₫</div>');
  const values = [...ctx.w.document.querySelectorAll('[data-motion-count]')];
  ctx.frame(0);
  ctx.frame(200);
  assert.deepEqual(values.map(v => v.textContent), ['20,947,817,562₫', '5.2%', '1.234₫']);
  assert.equal(values[0].getAttribute('data-tks-count-display'), '18,329,340,367₫');
  assert.equal(values[1].getAttribute('data-tks-count-display'), '4.6%');
  assert.equal(values[2].getAttribute('data-tks-count-display'), '1.080₫');
  ctx.frame(400);
  assert.ok(values.every(v => !v.classList.contains('tks-motion-count')));
  ctx.dom.window.close();
});

test('reduced motion starts static and changing preference cancels active effects immediately', () => {
  const staticCtx = setup('<div class="view-title">Title</div><div class="kpi-card"><div class="value">100</div></div>', true);
  assert.equal(staticCtx.animations.length, 0);
  assert.equal(staticCtx.w.document.querySelector('.view-title').childElementCount, 0);
  const ctx = setup('<div class="kpi-card"><div class="value">100</div></div>');
  ctx.reduce();
  assert.ok(ctx.animations.every(a => a.cancelled));
  assert.equal(ctx.w.document.querySelector('.value').classList.contains('tks-motion-count'), false);
  staticCtx.dom.window.close();
  ctx.dom.window.close();
});

test('unsupported animation APIs and explicit opt-out leave content untouched', () => {
  const ctx = setup('<div class="view-title">Title</div>', false, false);
  assert.equal(ctx.w.TKSMotion, undefined);
  assert.equal(ctx.w.document.querySelector('.view-title').innerHTML, 'Title');
  const off = setup('<main data-motion="off"><div class="view-title">Title</div></main>');
  assert.equal(off.animations.length, 0);
  ctx.dom.window.close();
  off.dom.window.close();
});

test('every entrance finishes quickly so data is readable almost immediately', () => {
  const ctx = setup('<div class="view-title">Báo cáo vòng đời đơn hàng theo cơ sở</div><div class="kpi-card"></div><div class="kpi-card"></div><div class="kpi-card"></div><div class="kpi-card"></div><div class="kpi-card"></div><div class="kpi-card"></div><div class="kpi-card"></div><main><table><tbody>' + '<tr><td>x</td></tr>'.repeat(20) + '</tbody></table></main>');
  const longest = Math.max(...ctx.animations.map(a => a.options.duration + a.options.delay));
  assert.ok(longest <= 450, 'longest entrance ' + longest + 'ms');
  ctx.dom.window.close();
});
