'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const publicDir = path.join(__dirname, '../../public');
const source = fs.readFileSync(path.join(publicDir, 'shared/search-clear.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function page(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(source);
  dom.window.TKSSearchClear.refresh();
  return dom;
}

for (const file of ['index.html', 'account/index.html', 'humanresources/index.html', 'cashbook/index.html', 'vt-positions/index.html','shipment/lifecycle/index.html']) {
  // vat-draft/index.html bo ra 22/10/2026: trang chi con o dan ma, khong con o tim kiem.
  test(file + ': every search has exactly one clear button', () => {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    assert.match(html, /shared\/search-clear\.js\?v=/);
    assert.match(html, /shared\/search-clear\.css\?v=/);
    const dom = page(html);
    const inputs = dom.window.document.querySelectorAll('input[type="search"], .search-box input, input[data-search-input]');
    assert.ok(inputs.length);
    for (const input of inputs) {
      const buttons = input.parentElement.querySelectorAll('.tks-search-clear');
      assert.equal(buttons.length, 1, input.id);
      input.value = 'Tìm thử';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert.equal(buttons[0].hidden, false, input.id);
      assert.ok(buttons[0].getAttribute('aria-label'));
      assert.equal(buttons[0].type, 'button');
    }
    dom.window.TKSSearchClear.refresh();
    assert.equal(dom.window.document.querySelectorAll('.tks-search-clear').length, inputs.length);
    dom.window.close();
  });
}

test('clear updates filtering once, hides the button and restores focus', () => {
  const dom = page('<input type="search" value="old"><div id="results">filtered</div>');
  const input = dom.window.document.querySelector('input');
  let calls = 0;
  input.addEventListener('input', () => { calls++; dom.window.document.getElementById('results').textContent = input.value || 'all'; });
  const button = input.parentElement.querySelector('button');
  button.click();
  assert.equal(input.value, '');
  assert.equal(calls, 1);
  assert.equal(dom.window.document.getElementById('results').textContent, 'all');
  assert.equal(button.hidden, true);
  assert.equal(dom.window.document.activeElement, input);
  dom.window.close();
});

test('existing clear logic is reused without duplicate filtering', () => {
  const dom = page('<div class="table-search-input-wrap"><input type="search" value="old"><button class="table-search-clear" type="button">×</button></div>');
  const input = dom.window.document.querySelector('input');
  const button = dom.window.document.querySelector('button');
  let calls = 0;
  button.onclick = () => { calls++; input.value = ''; input.focus(); };
  dom.window.TKSSearchClear.refresh();
  button.click();
  assert.equal(calls, 1);
  assert.equal(button.hidden, true);
  assert.equal(input.parentElement.querySelectorAll('button').length, 1);
  dom.window.close();
});

test('dynamic searches are enhanced after mount and remount', async () => {
  const dom = page('<div id="host"></div>');
  await settle();
  const host = dom.window.document.getElementById('host');
  for (let i = 0; i < 2; i++) {
    host.innerHTML = '<div class="table-search-input-wrap"><input type="search" value="saved"></div>';
    await settle();
    assert.equal(host.querySelectorAll('.tks-search-clear').length, 1);
    assert.equal(host.querySelector('button').hidden, false);
    host.querySelector('button').click();
    assert.equal(host.querySelector('input').value, '');
  }
  dom.window.close();
});

test('disabled and readonly searches cannot be cleared', async () => {
  const dom = page('<input type="search" value="old" disabled>');
  await settle();
  const input = dom.window.document.querySelector('input');
  const button = dom.window.document.querySelector('button');
  assert.equal(button.hidden, true);
  button.click();
  assert.equal(input.value, 'old');
  input.disabled = false;
  await settle();
  assert.equal(button.hidden, false);
  input.readOnly = true;
  await settle();
  assert.equal(button.hidden, true);
  dom.window.close();
});

test('shipment clear submits the empty query once; other forms do not submit', () => {
  const dom = page('<form><input data-search-input data-search-submit-on-clear value="HD01"></form><form><input type="search" value="field"></form>');
  const forms = dom.window.document.querySelectorAll('form');
  let submitted = 0;
  forms[0].addEventListener('submit', event => { event.preventDefault(); submitted++; });
  forms[1].addEventListener('submit', event => { event.preventDefault(); assert.fail('unrequested submission'); });
  forms.forEach(form => form.querySelector('button').click());
  assert.equal(submitted, 1);
  assert.equal(forms[0].querySelector('input').value, '');
  dom.window.close();
});
