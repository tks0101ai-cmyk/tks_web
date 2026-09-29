'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const htmlPath = path.join(publicDir, 'index.html');

function readDashboardHtml() {
  return fs.readFileSync(htmlPath, 'utf8');
}

test('giao dien gan dung 16 nut xuat Excel cho 16 bang co dinh', () => {
  const html = readDashboardHtml();
  const matches = [...html.matchAll(/openExportDialog\('([^']+)'\)/g)].map(match => match[1]);
  assert.equal(matches.length, 16);
  assert.equal(new Set(matches).size, 16);
  assert.deepEqual(matches.sort(), [
    'customers.debt', 'customers.productDetail', 'customers.revenue', 'debt.management',
    'invoices.orders', 'invoices.returns',
    'overview.new-products', 'overview.productReport', 'overview.purchases', 'overview.transactions',
    'products.all', 'products.child-categories', 'products.low-stock', 'products.newly-imported', 'products.top-selling',
    'suppliers.list'
  ].sort());
});

test('modal co du dieu khien chon truong va script inline bien dich hop le', () => {
  const html = readDashboardHtml();
  ['exportModalBackdrop', 'exportFieldSearch', 'exportFields', 'exportConfirmButton'].forEach(id => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim());
  scripts.forEach(script => assert.doesNotThrow(() => new Function(script)));
  assert.match(html, /field\.selected !== false \? ' checked' : ''/);
});

test('nut xuat ket qua tim kiem bi an rieng o tab Tong quan', () => {
  const html = readDashboardHtml();
  const functionMatch = html.match(/function searchExportButtonHtml\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(functionMatch, 'phai co helper tao nut xuat cho ket qua tim kiem');
  assert.match(functionMatch[1], /state\.view === 'overview'/);
  assert.match(functionMatch[1], /openExportDialog\(\\'search\.results\\'\)/);
});

// ---------------------------------------------------------------------------------------------
// Hanh vi hop thoai "Xuat Excel" trong jsdom. fetch, timer, tai file va alert do test dieu khien
// nen khong bao gio cham mang / co so du lieu that.
// ---------------------------------------------------------------------------------------------

const flush = () => new Promise(resolve => setImmediate(resolve));

function createExportDashboard() {
  const source = readDashboardHtml();
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#products' });
  const win = dom.window;
  win.HTMLCanvasElement.prototype.getContext = () => ({});
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    destroy() {}
  };
  win.setInterval = () => 1;
  win.requestAnimationFrame = callback => callback();
  win.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };

  const harness = { win, document: win.document, calls: [], timers: [], downloads: [], alerts: [], routes: {}, ignoreAbort: false };
  // setTimeout do test dieu khien: ghi lai do tre de kiem tra timeout 30s / 180s va kich hoat ngay lap tuc.
  win.setTimeout = (fn, delay) => { harness.timers.push({ fn, delay, cleared: false }); return harness.timers.length; };
  win.clearTimeout = id => { if (harness.timers[id - 1]) harness.timers[id - 1].cleared = true; };
  win.alert = message => { harness.alerts.push(message); };
  win.URL.createObjectURL = () => 'blob:tks-test';
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () {
    harness.downloads.push({ href: this.href, name: this.getAttribute('download') });
  };
  // Chi cac API /api/export* duoc ghi nhan; API khac tra ve phan hoi da khai bao trong harness.routes
  // (theo tien to URL) hoac treo mai nhu cac test frontend khac.
  win.fetch = (url, init) => new Promise((resolve, reject) => {
    if (!String(url).startsWith('/api/export')) {
      const route = Object.keys(harness.routes).find(prefix => String(url).startsWith(prefix));
      if (route) resolve(harness.routes[route]);
      return;
    }
    const call = { url: String(url), body: JSON.parse(init.body), signal: init.signal, resolve, reject };
    // Hanh vi that: abort -> fetch reject AbortError. ignoreAbort mo phong phan hoi da toi noi mang, chi xu ly tre.
    init.signal.addEventListener('abort', () => {
      if (!harness.ignoreAbort) reject(new win.DOMException('The operation was aborted.', 'AbortError'));
    });
    harness.calls.push(call);
  });

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    win.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => win.eval(script));

  harness.fieldsCalls = () => harness.calls.filter(call => call.url === '/api/export/fields');
  harness.fileCalls = () => harness.calls.filter(call => call.url === '/api/export');
  harness.text = id => harness.document.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
  harness.respondJson = (call, body, status = 200) => call.resolve({
    ok: status < 400, status, json: async () => body, blob: async () => new win.Blob(['{}']), headers: { get: () => '' }
  });
  harness.respondFile = (call, filename) => call.resolve({
    ok: true, status: 200, json: async () => ({}), blob: async () => new win.Blob(['xlsx']),
    headers: { get: name => (String(name).toLowerCase() === 'content-disposition' ? 'attachment; filename="' + filename + '"' : '') }
  });
  // Mo phong click tren nut: trinh duyet khong kich hoat onclick cua nut bi disabled.
  harness.click = id => {
    const button = harness.document.getElementById(id);
    if (button.disabled) return false;
    win.eval(button.getAttribute('onclick'));
    return true;
  };
  harness.fireTimeout = delay => {
    const timer = harness.timers.filter(item => item.delay === delay && !item.cleared).pop();
    assert.ok(timer, 'phai co timer ' + delay + 'ms dang chay');
    timer.cleared = true;
    timer.fn();
  };
  harness.activeTimeouts = delay => harness.timers.filter(item => item.delay === delay && !item.cleared).length;
  harness.exportStatusIsError = () => harness.document.getElementById('exportStatus').classList.contains('error');
  return harness;
}

function exportField(key, label, extra) {
  return Object.assign({ key, label, type: 'text', selected: true }, extra);
}

function exportMetadata(overrides) {
  return Object.assign({
    tableKey: 'products.all',
    title: 'Tất cả sản phẩm',
    selectionMode: 'custom',
    worksheets: [{
      key: 'products',
      name: 'Sản phẩm',
      rowCount: 1234,
      fields: [
        exportField('code', 'Mã hàng', { description: 'Mã sản phẩm trên KiotViet' }),
        exportField('name', 'Tên hàng'),
        exportField('category', 'Nhóm hàng', { selected: false })
      ]
    }]
  }, overrides);
}

function twoSheetMetadata() {
  return exportMetadata({
    worksheets: [
      { key: 'products', name: 'Sản phẩm', rowCount: 10, fields: [exportField('code', 'Mã hàng'), exportField('name', 'Tên hàng'), exportField('category', 'Nhóm hàng', { selected: false })] },
      { key: 'sales', name: 'Bán hàng', rowCount: null, fields: [exportField('qty', 'Số lượng bán'), exportField('amount', 'Doanh thu', { selected: false })] }
    ]
  });
}

// Mo hop thoai va tra loi danh sach truong de vao trang thai "da co danh sach".
async function openExportWithFields(harness, metadata, tableKey) {
  harness.win.openExportDialog(tableKey || 'products.all');
  harness.respondJson(harness.fieldsCalls().pop(), metadata || exportMetadata());
  await flush();
}

test('hop thoai lay danh sach truong voi chu thich tieng Viet, khong con nhac Google Sheets', async () => {
  const h = createExportDashboard();
  const { document } = h;
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();

  h.win.openExportDialog('products.all');
  assert.equal(document.getElementById('exportModalBackdrop').hidden, false);
  assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(h.text('exportModalSubtitle'), 'Đang lấy danh sách trường từ cơ sở dữ liệu…');
  assert.equal(h.text('exportFields'), 'Đang lấy danh sách trường…');
  assert.equal(document.getElementById('exportToolbar').hidden, true);
  assert.equal(document.getElementById('exportConfirmButton').hidden, true);
  assert.equal(document.getElementById('exportRetryButton').hidden, true);
  assert.equal(h.fieldsCalls().length, 1);
  assert.equal(h.fieldsCalls()[0].body.tableKey, 'products.all');
  assert.equal(h.fieldsCalls()[0].signal.aborted, false);
  assert.equal(h.activeTimeouts(30000), 1, 'lay danh sach truong phai co timeout 30 giay');

  h.respondJson(h.fieldsCalls()[0], exportMetadata());
  await flush();

  assert.equal(h.activeTimeouts(30000), 0, 'timeout phai duoc go khi da co phan hoi');
  assert.equal(h.text('exportModalTitle'), 'Xuất file · Tất cả sản phẩm');
  assert.equal(h.text('exportModalSubtitle'), 'Đã chọn sẵn các trường mặc định; có thể bổ sung hoặc bỏ các trường không cần.');
  const boxes = [...document.querySelectorAll('#exportFields input[type="checkbox"]')];
  assert.deepEqual(boxes.map(box => [box.value, box.checked]), [['code', true], ['name', true], ['category', false]]);
  const items = [...document.querySelectorAll('.export-field-item')];
  assert.equal(items[0].getAttribute('title'), 'Mã sản phẩm trên KiotViet', 'description hien thi nhu tooltip cua muc truong');
  assert.equal(items[1].hasAttribute('title'), false);
  assert.match(h.text('exportFields'), /1\D?234 dòng · 3 trường/);
  assert.equal(h.text('exportStatus'), 'Đã chọn 2/3 trường');
  assert.equal(document.getElementById('exportToolbar').hidden, false);
  assert.equal(document.getElementById('exportConfirmButton').hidden, false);
  assert.equal(document.getElementById('exportConfirmButton').disabled, false);
  assert.equal(document.getElementById('exportFieldSearch').disabled, false);

  // Khong con nhac "Google Sheets" o bat ky cho nao trong khoi Xuat Excel (markup, ma va chu thich hien thi).
  const html = readDashboardHtml();
  const exportCode = html.slice(html.indexOf('const EXPORT_FIELDS_TIMEOUT_MS'), html.indexOf('function retryExport'));
  assert.ok(exportCode.length > 1000, 'phai tim thay khoi ma Xuat Excel');
  assert.doesNotMatch(exportCode, /Sheets/);
  assert.doesNotMatch(document.getElementById('exportModalBackdrop').outerHTML, /Sheets/);
  assert.doesNotMatch(document.getElementById('exportModalBackdrop').textContent, /Sheets/);
  h.win.close();
});

test('X, Huy, Esc va click nen deu dong hop thoai ngay khi dang lay danh sach truong va huy fetch', async t => {
  const ways = {
    'nut Huy': h => assert.equal(h.click('exportCancelButton'), true, 'nut Huy khong duoc bi disabled khi dang tai'),
    'nut X': h => assert.equal(h.click('exportModalClose'), true, 'nut X khong duoc bi disabled khi dang tai'),
    'phim Esc': h => h.document.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    'click nen': h => h.win.handleExportBackdropClick({ target: h.document.getElementById('exportModalBackdrop') })
  };
  for (const [name, closeDialog] of Object.entries(ways)) {
    await t.test(name, async () => {
      const h = createExportDashboard();
      const { document } = h;
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();

      h.win.openExportDialog('products.all');
      const call = h.fieldsCalls()[0];
      assert.equal(call.signal.aborted, false);
      assert.equal(document.getElementById('exportModalClose').disabled, false);
      assert.equal(document.getElementById('exportCancelButton').disabled, false);

      closeDialog(h);
      assert.equal(document.getElementById('exportModalBackdrop').hidden, true, 'phai dong ngay, khong doi may chu');
      assert.equal(document.body.style.overflow, '', 'phai tra lai cuon trang');
      assert.equal(call.signal.aborted, true, 'phai huy fetch dang chay');
      assert.equal(h.activeTimeouts(30000), 0);
      assert.equal(document.activeElement, opener, 'phai tra focus ve nut da mo');

      await flush();
      assert.equal(document.getElementById('exportModalBackdrop').hidden, true, 'AbortError do nguoi dung huy khong duoc mo lai hop thoai');
      assert.equal(h.text('exportStatus'), '', 'huy chu dong thi im lang, khong bao loi');
      assert.equal(document.getElementById('exportFields').innerHTML, '');

      // Mo lai binh thuong sau khi huy.
      await openExportWithFields(h);
      assert.equal(document.getElementById('exportModalBackdrop').hidden, false);
      assert.equal(document.querySelectorAll('#exportFields input[type="checkbox"]').length, 3);
      h.win.close();
    });
  }
});

test('phan hoi tre sau khi da dong hoac mo lai khong ve de len hop thoai', async () => {
  const h = createExportDashboard();
  const { document } = h;
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  h.ignoreAbort = true; // phan hoi cu van toi noi sau khi da huy: code phai tu bo qua nho token

  h.win.openExportDialog('products.all');
  const first = h.fieldsCalls()[0];
  h.win.closeExportDialog();
  h.respondJson(first, exportMetadata({ title: 'Lần một' }));
  await flush();
  assert.equal(document.getElementById('exportModalBackdrop').hidden, true, 'phan hoi tre khong duoc mo lai hop thoai da dong');
  assert.equal(document.getElementById('exportFields').innerHTML, '');
  assert.equal(document.getElementById('exportToolbar').hidden, true);
  assert.equal(document.body.style.overflow, '');

  // Bam lien tiep nhieu nut Xuat Excel: request cu bi huy, chi request cuoi cung con hieu luc.
  h.win.openExportDialog('products.low-stock');
  h.win.openExportDialog('products.top-selling');
  const [, second, third] = h.fieldsCalls();
  assert.equal(h.fieldsCalls().length, 3);
  assert.equal(second.signal.aborted, true, 'mo lai phai huy request cu');
  assert.equal(third.signal.aborted, false);
  assert.equal(h.activeTimeouts(30000), 1, 'chi con mot timeout cua request moi nhat');

  h.respondJson(second, exportMetadata({ title: 'Lần hai' }));
  await flush();
  assert.equal(h.text('exportFields'), 'Đang lấy danh sách trường…', 'phan hoi cu khong duoc ve de len lan mo moi');
  assert.equal(h.text('exportModalTitle'), 'Xuất file');

  h.respondJson(third, exportMetadata({ title: 'Lần ba' }));
  await flush();
  assert.equal(h.text('exportModalTitle'), 'Xuất file · Lần ba');
  assert.equal(document.querySelectorAll('#exportFields input[type="checkbox"]').length, 3);

  h.win.closeExportDialog();
  assert.equal(document.activeElement, opener, 'mo lai khi dang mo van tra focus ve nut ban dau');
  h.win.close();
});

test('phan hoi tai file den tre sau khi dong hop thoai khong tu tai xuong', async () => {
  const h = createExportDashboard();
  h.ignoreAbort = true;
  await openExportWithFields(h);
  assert.equal(h.click('exportConfirmButton'), true);
  const fileCall = h.fileCalls()[0];
  assert.equal(h.activeTimeouts(180000), 1, 'tao file phai co timeout 180 giay');
  assert.equal(h.click('exportCancelButton'), true, 'Huy phai dong duoc ngay ca khi dang tao file');
  assert.equal(fileCall.signal.aborted, true);
  assert.equal(h.document.getElementById('exportModalBackdrop').hidden, true);
  assert.equal(h.activeTimeouts(180000), 0);

  h.respondFile(fileCall, 'TKS_Tre.xlsx');
  await flush();
  assert.equal(h.downloads.length, 0, 'khong duoc tu tai file cua lan da huy');
  assert.equal(h.document.getElementById('exportModalBackdrop').hidden, true);
  h.win.close();
});

test('het thoi gian lay danh sach truong thi bao loi tieng Viet va nut Thu lai goi lai dung buoc do', async () => {
  const h = createExportDashboard();
  const { document } = h;
  h.win.openExportDialog('products.all');
  const first = h.fieldsCalls()[0];
  h.fireTimeout(30000);
  assert.equal(first.signal.aborted, true);
  await flush();

  assert.match(h.text('exportStatus'), /^Máy chủ phản hồi quá lâu/);
  assert.equal(h.exportStatusIsError(), true);
  assert.equal(h.text('exportFields'), 'Không thể tải danh sách trường.');
  assert.equal(document.getElementById('exportModalBackdrop').hidden, false, 'loi khong duoc tu dong dong hop thoai');
  const retry = document.getElementById('exportRetryButton');
  assert.equal(retry.hidden, false);
  assert.equal(retry.textContent.trim(), 'Thử lại');
  assert.equal(document.getElementById('exportCancelButton').disabled, false);

  assert.equal(h.click('exportRetryButton'), true);
  assert.equal(h.fieldsCalls().length, 2, 'Thu lai phai goi lai /api/export/fields');
  assert.equal(h.fieldsCalls()[1].body.tableKey, 'products.all');
  assert.equal(retry.hidden, true);
  assert.equal(h.text('exportStatus'), '');
  assert.equal(h.text('exportFields'), 'Đang lấy danh sách trường…');
  assert.equal(h.activeTimeouts(30000), 1);

  h.respondJson(h.fieldsCalls()[1], exportMetadata());
  await flush();
  assert.equal(document.querySelectorAll('#exportFields input[type="checkbox"]').length, 3);
  assert.equal(retry.hidden, true);
  h.win.close();
});

test('het thoi gian tao file thi bao loi + Thu lai, giu nguyen cac truong da chon roi tai file thanh cong', async () => {
  const h = createExportDashboard();
  const { document } = h;
  await openExportWithFields(h, twoSheetMetadata());
  assert.equal(h.click('exportConfirmButton'), true);
  const first = h.fileCalls()[0];
  assert.equal(h.text('exportStatus'), 'Đang tạo file Excel… (dữ liệu lớn có thể mất vài chục giây)');
  assert.equal(document.getElementById('exportConfirmButton').disabled, true);
  assert.equal(document.getElementById('exportFieldSearch').disabled, true);
  assert.equal(document.getElementById('exportCancelButton').disabled, false);
  assert.equal(document.getElementById('exportModalClose').disabled, false);

  h.fireTimeout(180000);
  assert.equal(first.signal.aborted, true);
  await flush();
  assert.match(h.text('exportStatus'), /^Máy chủ phản hồi quá lâu khi tạo file Excel/);
  assert.equal(h.exportStatusIsError(), true);
  assert.equal(document.getElementById('exportRetryButton').hidden, false);
  assert.equal(document.getElementById('exportConfirmButton').disabled, false);
  assert.equal(document.querySelectorAll('#exportFields input[type="checkbox"]').length, 5, 'danh sach truong van con de chon lai');
  assert.equal(document.getElementById('exportModalBackdrop').hidden, false);

  assert.equal(h.click('exportRetryButton'), true);
  assert.equal(h.fileCalls().length, 2);
  assert.deepEqual(h.fileCalls()[1].body.columns, first.body.columns, 'Thu lai giu nguyen cac truong da chon');
  h.respondFile(h.fileCalls()[1], 'TKS_Thu_lai.xlsx');
  await flush();
  assert.deepEqual(h.downloads.map(item => item.name), ['TKS_Thu_lai.xlsx']);
  assert.equal(document.getElementById('exportModalBackdrop').hidden, true);
  assert.equal(document.body.style.overflow, '');
  h.win.close();
});

test('loi HTTP tu may chu hien thong bao cua may chu va cho phep Thu lai', async () => {
  const h = createExportDashboard();
  h.win.openExportDialog('products.all');
  h.respondJson(h.fieldsCalls()[0], { error: 'Phiên đăng nhập đã hết hạn' }, 401);
  await flush();
  assert.equal(h.text('exportStatus'), 'Phiên đăng nhập đã hết hạn');
  assert.equal(h.exportStatusIsError(), true);
  assert.equal(h.document.getElementById('exportRetryButton').hidden, false);
  assert.equal(h.text('exportFields'), 'Không thể tải danh sách trường.');

  h.win.openExportDialog('products.all'); // mo lai bang nut khac cung phai reset ve trang thai cho
  assert.equal(h.document.getElementById('exportRetryButton').hidden, true);
  h.respondJson(h.fieldsCalls()[1], { title: 'Sai định dạng' }); // thieu worksheets
  await flush();
  assert.match(h.text('exportStatus'), /không hợp lệ/);
  assert.equal(h.document.getElementById('exportRetryButton').hidden, false);
  h.win.close();
});

test('rowCount la null thi chi hien so truong, rowCount la so thi hien them so dong', async () => {
  const h = createExportDashboard();
  await openExportWithFields(h, exportMetadata({
    worksheets: [
      { key: 'a', name: 'Đơn hàng', rowCount: null, fields: [exportField('x', 'Mã đơn'), exportField('y', 'Ngày bán')] },
      { key: 'b', name: 'Chi tiết', rowCount: 0, fields: [exportField('z', 'Số lượng')] },
      { key: 'c', name: 'Tổng hợp', fields: [exportField('w', 'Doanh thu'), exportField('v', 'Lợi nhuận')] }
    ]
  }));
  const counts = [...h.document.querySelectorAll('.export-group-count')].map(node => node.textContent.trim());
  assert.deepEqual(counts, ['2 trường', '0 dòng · 1 trường', '2 trường']);
  h.win.close();
});

test('tai file thanh cong goi /api/export dung cac cot da chon theo tung worksheet', async () => {
  const h = createExportDashboard();
  const { document } = h;
  await openExportWithFields(h, twoSheetMetadata());
  const box = (sheet, key) => document.querySelector(`#exportFields input[data-export-sheet="${sheet}"][value="${key}"]`);
  box('products', 'name').checked = false; // bo mot truong mac dinh
  box('products', 'category').checked = true; // them mot truong khong mac dinh
  h.win.updateExportSelectionStatus();
  assert.equal(h.text('exportStatus'), 'Đã chọn 3/5 trường');

  assert.equal(h.click('exportConfirmButton'), true);
  assert.equal(h.fileCalls().length, 1);
  const call = h.fileCalls()[0];
  assert.equal(call.body.tableKey, 'products.all');
  assert.deepEqual(call.body.columns, { products: ['code', 'category'], sales: ['qty'] });
  assert.equal(h.text('exportStatus'), 'Đang tạo file Excel… (dữ liệu lớn có thể mất vài chục giây)');
  assert.equal(document.getElementById('exportModalBackdrop').hidden, false, 'dang tao file thi chua dong hop thoai');

  h.respondFile(call, 'TKS_San_pham.xlsx');
  await flush();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].name, 'TKS_San_pham.xlsx');
  assert.equal(h.downloads[0].href, 'blob:tks-test');
  assert.equal(document.getElementById('exportModalBackdrop').hidden, true);
  assert.equal(document.body.style.overflow, '');
  assert.equal(h.activeTimeouts(180000), 0);
  h.win.close();
});

test('bam xac nhan khi khong chon truong nao thi bao loi va khong goi /api/export', async () => {
  const h = createExportDashboard();
  await openExportWithFields(h);
  h.win.setVisibleExportFields(false);
  assert.equal(h.text('exportStatus'), 'Đã chọn 0/3 trường');
  assert.equal(h.click('exportConfirmButton'), true);
  assert.equal(h.fileCalls().length, 0, 'khong duoc goi may chu khi chua chon truong nao');
  assert.equal(h.text('exportStatus'), 'Vui lòng chọn ít nhất một trường để xuất.');
  assert.equal(h.exportStatusIsError(), true);
  assert.equal(h.document.getElementById('exportRetryButton').hidden, true);
  assert.equal(h.document.getElementById('exportModalBackdrop').hidden, false);
  h.win.close();
});

test('ket qua nhieu nguon (all-only) tu tao file voi toan bo truong, huy duoc va thu lai duoc', async () => {
  const h = createExportDashboard();
  const { document } = h;
  await openExportWithFields(h, twoSheetMetadata());
  h.win.closeExportDialog();

  h.win.openExportDialog('search.results');
  h.respondJson(h.fieldsCalls().pop(), Object.assign(twoSheetMetadata(), { tableKey: 'search.results', selectionMode: 'all-only' }));
  await flush();
  assert.equal(h.text('exportModalSubtitle'), 'Kết quả có nhiều nguồn; mỗi nguồn sẽ nằm trong một worksheet riêng.');
  assert.equal(h.text('exportFields'), 'Đang tạo file với toàn bộ trường của 2 nguồn dữ liệu…');
  assert.equal(h.fileCalls().length, 1);
  assert.equal(h.fileCalls()[0].body.tableKey, 'search.results');
  assert.equal('columns' in h.fileCalls()[0].body, false, 'all-only khong gui danh sach cot');

  h.fireTimeout(180000);
  await flush();
  assert.match(h.text('exportStatus'), /^Máy chủ phản hồi quá lâu/);
  assert.equal(h.text('exportFields'), 'Không thể tạo file Excel.');
  assert.equal(document.getElementById('exportRetryButton').hidden, false);

  assert.equal(h.click('exportRetryButton'), true);
  assert.equal(h.fileCalls().length, 2, 'Thu lai o che do all-only phai tao lai file, khong quay lai buoc lay truong');
  assert.equal(h.fieldsCalls().length, 2);
  assert.equal(h.text('exportFields'), 'Đang tạo file với toàn bộ trường của 2 nguồn dữ liệu…');

  assert.equal(h.click('exportModalClose'), true);
  assert.equal(h.fileCalls()[1].signal.aborted, true);
  assert.equal(document.getElementById('exportModalBackdrop').hidden, true);
  h.win.close();
});

test('nut xuat ket qua dut hang co timeout va bao loi tieng Viet thay vi ket o "Dang xuat"', async () => {
  const result = {
    rows: [{ code: 'SP001', name: 'Chổi lau nhà', lastOutOfStockDate: '2026-09-01', daysOutOfStock: 20, periods: [] }],
    sources: {}, warnings: [], asOfDate: '2026-09-21', totalProductsScanned: 10
  };
  const h = createExportDashboard();
  // Nap ket qua quet qua luong that (fetchRecentStockoutResult) de nut xuat duoc bat len.
  h.routes['/api/products/stockout-recent/'] = { ok: true, status: 200, json: async () => ({ result }) };
  await h.win.fetchRecentStockoutResult('job-1');
  const button = h.document.getElementById('recentStockoutExportButton');
  assert.equal(button.disabled, false, 'phai co ket qua de xuat');
  const originalLabel = button.innerHTML;

  const pending = h.win.exportRecentStockoutResult();
  assert.equal(h.fileCalls().length, 1);
  assert.equal(h.fileCalls()[0].body.tableKey, 'stockout.recentScan');
  assert.equal(button.disabled, true);
  assert.equal(h.activeTimeouts(180000), 1);

  h.fireTimeout(180000);
  await pending;
  assert.equal(h.fileCalls()[0].signal.aborted, true);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /^Máy chủ phản hồi quá lâu/);
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, originalLabel);
  h.win.close();
});

test('lop nen hop thoai Xuat Excel khong dung backdrop-filter de khong lam lag ca trang', () => {
  const html = readDashboardHtml();
  const block = html.match(/\.export-modal-backdrop\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(block, 'phai co khoi CSS .export-modal-backdrop');
  assert.doesNotMatch(block[0].replace(/\/\*[\s\S]*?\*\//g, ''), /backdrop-filter/);
});

// ---------------------------------------------------------------------------------------------
// Sua loi sau review: tieu diem ban phim, loi mang khi doc body, nut xuat khi khong co ket qua.
// ---------------------------------------------------------------------------------------------

test('mo hop thoai dua tieu diem vao nut Huy; nut Xuat Excel bi khoa khi dang giu tieu diem thi chuyen ve Huy, loi thi tieu diem vao Thu lai', async () => {
  const h = createExportDashboard();
  const { document } = h;
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();
  await openExportWithFields(h, exportMetadata());
  // openExportWithFields dua tieu diem vao o tim truong sau khi co danh sach; luc dang cho phai o nut Huy.
  h.win.closeExportDialog();
  assert.equal(document.activeElement, trigger, 'dong hop thoai tra tieu diem ve nut mo');

  h.win.openExportDialog('products.all');
  assert.equal(document.activeElement, document.getElementById('exportCancelButton'), 'dang lay danh sach truong: tieu diem o nut Huy, khong o trang phia sau');
  h.respondJson(h.fieldsCalls().pop(), exportMetadata());
  await flush();

  const confirm = document.getElementById('exportConfirmButton');
  confirm.focus();
  assert.equal(document.activeElement, confirm);
  assert.equal(h.click('exportConfirmButton'), true);
  assert.equal(confirm.disabled, true);
  assert.equal(document.activeElement, document.getElementById('exportCancelButton'), 'nut vua bi khoa khong duoc lam mat tieu diem');

  h.respondJson(h.fileCalls().pop(), { error: 'Lỗi tạo file', code: 'EXPORT_NO_DATA' }, 500);
  await flush();
  const retry = document.getElementById('exportRetryButton');
  assert.equal(retry.hidden, false);
  assert.equal(document.activeElement, retry, 'loi hien nut Thu lai thi tieu diem chuyen vao do');

  h.click('exportRetryButton');
  assert.equal(retry.hidden, true);
  assert.equal(document.activeElement, document.getElementById('exportCancelButton'), 'Thu lai bi an khi dang giu tieu diem thi tra ve Huy');
  h.win.close();
});

test('mat ket noi giua luc doc body (TypeError cua trinh duyet) van hien thong bao tieng Viet', async () => {
  const h = createExportDashboard();
  h.win.openExportDialog('products.all');
  h.fieldsCalls()[0].resolve({
    ok: true, status: 200, json: async () => { throw new h.win.TypeError('network error'); }, headers: { get: () => '' }
  });
  await flush();
  assert.equal(h.text('exportStatus'), 'Không kết nối được máy chủ. Vui lòng kiểm tra đường truyền rồi thử lại.');
  assert.equal(h.exportStatusIsError(), true);

  h.click('exportRetryButton');
  h.respondJson(h.fieldsCalls()[1], exportMetadata());
  await flush();
  h.win.confirmExport();
  h.fileCalls()[0].resolve({
    ok: true, status: 200, json: async () => ({}), blob: async () => { throw new h.win.TypeError('Failed to fetch'); }, headers: { get: () => '' }
  });
  await flush();
  assert.equal(h.text('exportStatus'), 'Không kết nối được máy chủ. Vui lòng kiểm tra đường truyền rồi thử lại.');
  assert.doesNotMatch(h.text('exportStatus'), /Failed to fetch|network error/);
  h.win.close();
});


test('nut Xuat HTML canh Xuat Excel gui format html cung cac truong da chon, loi thi Thu lai dung dinh dang', async () => {
  const h = createExportDashboard();
  const { document } = h;
  assert.equal(document.getElementById('exportHtmlButton').hidden, true, 'chua co danh sach truong thi an');
  await openExportWithFields(h, twoSheetMetadata());
  assert.equal(document.getElementById('exportHtmlButton').hidden, false);

  assert.equal(h.click('exportHtmlButton'), true);
  const call = h.fileCalls()[0];
  assert.equal(call.body.format, 'html');
  assert.deepEqual(call.body.columns, { products: ['code', 'name'], sales: ['qty'] });
  assert.equal(h.text('exportStatus'), 'Đang tạo báo cáo HTML… (dữ liệu lớn có thể mất vài chục giây)');
  assert.equal(document.getElementById('exportHtmlButton').disabled, true, 'dang tao file thi khoa nut');

  h.respondJson(call, { error: 'Không thể tạo báo cáo HTML.', detail: 'Dữ liệu có 6.000 dòng, vượt giới hạn — dùng Xuất Excel.' }, 413);
  await flush();
  assert.match(h.text('exportStatus'), /Xuất Excel/);
  assert.equal(h.click('exportRetryButton'), true);
  assert.equal(h.fileCalls()[1].body.format, 'html', 'Thu lai giu dinh dang HTML');
  h.respondFile(h.fileCalls()[1], 'HN_San_pham_20260925_1000.html');
  await flush();
  assert.equal(h.downloads[0].name, 'HN_San_pham_20260925_1000.html');

  // Nut Xuat Excel van gui yeu cau KHONG co format (giu hanh vi cu).
  await openExportWithFields(h, twoSheetMetadata());
  h.click('exportConfirmButton');
  assert.equal('format' in h.fileCalls()[2].body, false);
  h.win.close();
});

test('Xuat HTML ma may chu tra file .xlsx (server cu) thi bao loi, khong luu file sai dinh dang', async () => {
  const h = createExportDashboard();
  await openExportWithFields(h, twoSheetMetadata());
  h.click('exportHtmlButton');
  h.respondFile(h.fileCalls()[0], 'HN_San_pham_20260925_1000.xlsx');
  await flush();
  assert.equal(h.downloads.length, 0);
  assert.match(h.text('exportStatus'), /chưa hỗ trợ xuất HTML/);
  assert.equal(h.exportStatusIsError(), true);
  h.win.close();
});

test('xuat file gui bo loc rieng cua tung khoi: Hang moi nhap (ni), Ma moi tao (np), Tong quan (pr)', async () => {
  const h = createExportDashboard();
  h.win.eval("setMiniFilterDays('newlyImported', 7)");
  h.win.eval("setMiniFilterAll('newProducts')");
  h.win.eval("setMiniFilterDays('products', 90)");

  h.win.openExportDialog('products.newly-imported');
  const body = h.fieldsCalls().pop().body;
  assert.deepEqual(body.filters.newlyImported, { mode: 'days', days: 7 });
  assert.deepEqual(body.filters.newProducts, { mode: 'all' });
  assert.deepEqual(body.filters.products, { mode: 'days', days: 90, status: 'all' });
  h.win.close();
});
