const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'workspace.css'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'purchase.js'), 'utf8');

test('order toolbar keeps primary actions first and secondary actions grouped last', () => {
  const doc = new JSDOM(page).window.document;
  const toolbar = doc.querySelector('#orders .order-actions');
  const order = [...toolbar.children]
    .filter(node => node.matches('h2') || node.matches('button') && !node.hidden)
    .map(node => node.matches('h2') ? 'heading' : node.id);

  assert.deepEqual(order, [
    'heading', 'add', 'bulk', 'trashRows', 'import', 'export',
    'managePurchaseEmployees'
  ]);
});

test('order lifecycle replaces the supplier dropdown and container trash stays available', () => {
  const doc = new JSDOM(page).window.document;
  assert.equal(doc.getElementById('orderLifecycle').tagName, 'SELECT');
  assert.equal(doc.getElementById('orderSupplier'), null);
  assert.ok(doc.querySelector('#orderBuyer').closest('label').nextElementSibling.querySelector('#orderLifecycle'));
  assert.match(script, /data-key="_lifecycle"[^>]*>Trạng thái/);
  assert.deepEqual([...doc.querySelectorAll('#orderLifecycle option')].map(option => [option.value, option.textContent]), [['active','Hoạt động'],['inactive','Ngừng hoạt động']]);
  assert.match(script, /purchase-lifecycle-badge is-active/);
  assert.match(script, /purchase-lifecycle-badge is-inactive/);
  assert.equal(doc.getElementById('contLifecycle')?.options.length, 3);
  assert.ok(doc.getElementById('containerSelect'));
  assert.equal(doc.getElementById('containerDeleteSelected').hidden, true);
  assert.equal(doc.getElementById('containerInactiveRows'), null);
  assert.ok(doc.getElementById('containerTrashRows'));
});

test('container selection replaces row actions and container lifecycle can be toggled in place', () => {
  assert.match(script, /containerSelectMode\?\[\['Chọn',52\]\]:\[\]/);
  assert.match(script, /data-container-pick-all/);
  assert.match(script, /containerSelectMode&&i===0/);
  assert.match(styles, /#orderLifecycle/);
  assert.doesNotMatch(styles, /#orderSupplier/);
  assert.match(script, /data-container-lifecycle/);
  assert.match(script, /containerDeleteSelected.*deleteSelectedContainers/s);
});

test('container filters fit in a compact desktop row', () => {
  assert.match(styles, /#containerPanel \.container-filters\{grid-template-columns:minmax\(260px,3fr\) repeat\(4,minmax\(110px,1fr\)\) minmax\(92px,auto\)/);
  assert.match(styles, /#containerPanel \.container-filters>button\{grid-column:6;grid-row:1/);
});

test('filter summary follows the title and pushes toolbar actions to the right', () => {
  assert.ok(
    /\.purchase-page\s+\.order-actions\s+#orderFilterSummary\s*\{[^}]*margin:\s*0\s+auto\s+0\s+0/i.test(styles),
    'the summary needs an auto right margin to push actions to the right'
  );
});

test('filter summary sits beside the order title in the top toolbar', () => {
  const doc = new JSDOM(page).window.document;
  const heading = doc.querySelector('.order-actions h2');
  const summary = doc.getElementById('orderFilterSummary');
  assert.equal(heading.nextElementSibling, summary);
  assert.equal(summary.parentElement, doc.querySelector('.order-actions'));
});

test('bulk and employee buttons keep dark text in light mode', () => {
  assert.ok(
    /:root\[data-theme="light"\][^{]*\.order-actions[^}]*#bulk[^}]*#managePurchaseEmployees[^}]*color:\s*#0f172a/i.test(styles),
    'light mode needs a dark-text override for #bulk and #managePurchaseEmployees'
  );
});

test('import uses the normal opaque button background', () => {
  assert.ok(
    !/\.order-actions[^{}]*#import[^{}]*\{[^}]*background:\s*transparent/i.test(styles),
    '#import must use the shared opaque button treatment'
  );
});

test('undo is keyboard-only and the task dropdown is removed', () => {
  assert.doesNotMatch(script, /<button id="undoWork"/);
  assert.doesNotMatch(script, /<summary>Tác vụ/);
  assert.match(script, /e\.ctrlKey\|\|e\.metaKey[^\n]*e\.key\.toLowerCase\(\)!==['"]z['"]/i);
});

test('requested compact date and row key columns reserve a narrower default width', () => {
  assert.match(script, /c\.k==='rowKey'\|\|\['listedAt','orderedNote','shippedNote','etaNote','arrivedNote'\]\.includes\(c\.k\)/);
});

test('six compact order columns use reduced text size', () => {
  assert.match(styles, /#orderTable\s+:is\([^{}]*rowKey[^{}]*arrivedNote[^{}]*\)\s*\{font-size:\s*8\.5px\s*!important/i);
});

test('container panel opens by default and sits 20px below the order grid', () => {
  const doc = new JSDOM(page).window.document;
  assert.equal(doc.querySelector('#containerPanel').hasAttribute('open'), true);
  assert.ok(
    /#containerPanel\s*\{[^}]*margin-top:\s*20px/i.test(styles),
    'container panel should have a 20px top margin'
  );
});

test('container status chips share the first orders toolbar row and all requested page sizes are available', () => {
  const doc = new JSDOM(page).window.document;
  const toolbar = doc.querySelector('#orders .order-actions');
  assert.equal(toolbar.querySelector('#containerStatusBoard')?.parentElement, toolbar);
  assert.deepEqual(
    [...doc.querySelectorAll('#pageSize option')].map(option => option.value),
    ['10', '50', '100', '150', '200']
  );
});

test('order grid keeps both scroll axes inside a bounded viewport and notices use a visible toast', () => {
  assert.match(styles, /\.purchase-page\s+#orderTable\s*\{[^}]*max-height:\s*67vh[^}]*overflow:\s*auto/i);
  assert.match(styles, /#notice\.toast\s*\{[^}]*position:\s*fixed/i);
});

test('pinned order cells stay opaque over scrolled rows, including draft cells', () => {
  assert.match(styles, /#orderTable\s+tbody\s*>\s*tr\s*>\s*td\.purchase-pinned-column\s*\{[^}]*background-color:\s*var\(--panel\)\s*!important/i);
  assert.match(styles, /#orderTable\s+tbody\s*>\s*tr\s*>\s*td\.purchase-pinned-column\.draft\s*\{[^}]*background-color:\s*color-mix\(in\s+srgb,\s*var\(--primary\)\s+13%,\s*var\(--panel\)\)\s*!important/i);
});
