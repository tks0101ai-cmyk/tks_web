const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'workspace.css'), 'utf8');

test('order toolbar keeps primary actions first and secondary actions grouped last', () => {
  const doc = new JSDOM(page).window.document;
  const toolbar = doc.querySelector('#orders .order-actions');
  const order = [...toolbar.children]
    .filter(node => node.matches('h2, button'))
    .map(node => node.matches('h2') ? 'heading' : node.id);

  assert.deepEqual(order, [
    'heading', 'add', 'bulk', 'import', 'export',
    'managePurchaseEmployees', 'editedRows', 'save', 'cancel'
  ]);
});

test('order title stays left and pushes toolbar actions to the right', () => {
  assert.ok(
    /\.purchase-page\s+\.order-actions\s+h2\s*\{[^}]*margin-right:\s*auto/i.test(styles),
    'the title needs an auto right margin to push actions to the right'
  );
});

test('bulk and employee buttons keep dark text in light mode', () => {
  assert.ok(
    /:root\[data-theme="light"\][^{]*\.order-actions[^}]*#bulk[^}]*#managePurchaseEmployees[^}]*color:\s*#0f172a/i.test(styles),
    'light mode needs a dark-text override for #bulk and #managePurchaseEmployees'
  );
});

test('import and undo use the normal opaque button background', () => {
  assert.ok(
    !/\.order-actions[^{}]*#(?:import|undoWork)[^{}]*\{[^}]*background:\s*transparent/i.test(styles),
    '#import and #undoWork must use the shared opaque button treatment'
  );
});

test('container panel opens by default and sits 20px below the order grid', () => {
  const doc = new JSDOM(page).window.document;
  assert.equal(doc.querySelector('#containerPanel').hasAttribute('open'), true);
  assert.ok(
    /#containerPanel\s*\{[^}]*margin-top:\s*20px/i.test(styles),
    'container panel should have a 20px top margin'
  );
});
