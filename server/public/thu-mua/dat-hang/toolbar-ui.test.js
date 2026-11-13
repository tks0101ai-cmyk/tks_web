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
    'heading', 'add', 'bulk', 'inactiveRows', 'trashRows', 'import', 'export',
    'managePurchaseEmployees'
  ]);
});

test('order and container tables expose the HĐ/NHĐ lifecycle and container trash controls', () => {
  const doc = new JSDOM(page).window.document;
  assert.match(script, /data-key="_lifecycle"[^>]*>HĐ\/NHĐ/);
  assert.match(script, /purchase-lifecycle-badge is-active/);
  assert.match(script, /purchase-lifecycle-badge is-inactive/);
  assert.equal(doc.getElementById('contLifecycle')?.options.length, 3);
  assert.ok(doc.getElementById('containerInactiveRows'));
  assert.ok(doc.getElementById('containerTrashRows'));
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
