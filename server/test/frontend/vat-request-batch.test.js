'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '../../public/vat-request');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const batchCode = fs.readFileSync(path.join(publicDir, 'vat-request-batch.js'), 'utf8');

test('prefill tai su dung dong trong sau cac dong nhap va de Full VAT chua chon', async t => {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vat-request/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  window.eval(batchCode);
  const batch = window.TKSVatRequestBatch.createBatchForm({
    api: async (url, options) => {
      calls.push({ url, method: options.method });
      return { results: {} };
    },
    escapeHtml: String,
    fmtNumber: String,
    debounce: fn => fn,
    showDialog: dialog => dialog.setAttribute('open', ''),
    closeDialog: dialog => dialog.removeAttribute('open'),
    userId: 'sale'
  });
  const existing = { customerName: 'Khách cũ', productCode: 'SP1', quantity: 2, unitPrice: 100, fullVat: true };
  window.localStorage.setItem('vr-batch-draft:sale', JSON.stringify({ rows: [existing] }));
  batch.open();
  const blank = batch.addRow();
  batch.addRow({ ...existing, productCode: 'SP2', fullVat: false });

  assert.equal(batch.prefill([{
    customerName: 'Khách mới', productCode: 'SP3', quantity: 1.25, unitPrice: 90,
    saleNote: 'Từ HD1', fullVat: true
  }], 'HD1'), 1);
  const rows = [...doc.querySelectorAll('#vrBatchRows tr')];
  const field = (row, name) => row.querySelector('[data-field="' + name + '"]').value;
  assert.equal(rows[2], blank);
  assert.deepEqual(rows.map(row => field(row, 'productCode')), ['SP1', 'SP2', 'SP3']);
  assert.deepEqual(rows.map(row => field(row, 'fullVat')), ['true', 'false', '']);
  assert.equal(field(blank, 'customerName'), 'Khách mới');
  assert.equal(field(blank, 'quantity'), '1.25');
  assert.equal(field(blank, 'unitPrice'), '90');
  assert.equal(field(blank, 'saleNote'), 'Từ HD1');

  await batch.submit();
  assert.match(doc.getElementById('vrBatchError').textContent, /chưa chọn Full VAT/i);
  assert.deepEqual(calls, [{ url: '/lookup', method: 'POST' }, { url: '/lookup', method: 'POST' }]);
});
