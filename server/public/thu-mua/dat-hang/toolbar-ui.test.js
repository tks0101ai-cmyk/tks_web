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

test('bulk and employee buttons keep dark text in light mode', () => {
  assert.ok(
    /:root\[data-theme="light"\][^{]*\.order-actions[^}]*#bulk[^}]*#managePurchaseEmployees[^}]*color:\s*#0f172a/i.test(styles),
    'light mode needs a dark-text override for #bulk and #managePurchaseEmployees'
  );
});

test('toolbar utility buttons retain visible borders at rest', () => {
  assert.ok(
    !/\.order-actions[^{}]*#(?:managePurchaseEmployees|import|undoWork)[^{}]*\{[^}]*border-color:\s*transparent/i.test(styles),
    'toolbar utility buttons must not hide their borders at rest'
  );
});
