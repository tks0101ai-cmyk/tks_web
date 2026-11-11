'use strict';
// Hộp chi tiết một dòng của trang VT Hà Nội / VT Sài Gòn: bấm dòng → thông số, lịch sử của dòng, Lưu / Xóa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vt-positions/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const row = (id, extra = {}) => ({
  id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id,
  quantity: 200, held: 50, available: 150, kiotQuantity: 350, warnings: [], updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const entry = (id, extra = {}) => ({
  id, createdAt: '2026-10-27T03:00:00Z', branch: 'HN', code: 'MA1', location: 'K1', action: 'edit', field: 'notes', oldValue: '1T x 100', newValue: '2T x 100', actorName: 'Lan', ...extra
});

async function setup(t, { data = { HN: [row(1), row(2)], SG: [row(3)] }, canEdit = true, handler } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = {
    vaiTro: 'Quản lý', branch: 'Cả hai',
    permissions: [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])],
    pageFeatures: PAGE_FEATURES
  };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, options });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') {
      const target = parsed.searchParams.get('branch');
      return json({ branch: target, canEdit, canExport: false, rows: data[target] });
    }
    if (handler) { const answer = await handler(url, options, parsed); if (answer) return answer; }
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/history') return json({ rows: [], nextBefore: null });
    return json({ error: 'Không có mock', code: 'NO_MOCK' }, 500);
  };
  window.eval(code);
  await window.TKSVtPositions.init();
  const doc = window.document;
  return {
    window, doc, calls,
    open: async id => { doc.querySelector('#vtRows tr[data-id="' + id + '"]').click(); await settle(); },
    isOpen: () => doc.getElementById('vtDetailDialog').hasAttribute('open'),
    field: name => doc.getElementById('vtDetailForm').elements[name],
    type: (name, value) => {
      const input = doc.getElementById('vtDetailForm').elements[name];
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    save: async () => { doc.getElementById('vtDetailSave').click(); await settle(); },
    text: id => doc.getElementById(id).textContent
  };
}

test('bấm dòng mở hộp chi tiết: mã, tên, vị trí và thông số SL thùng / SL chiếc / SL Kiot / Vị trí / Ngày về', async t => {
  const ui = await setup(t, { data: { HN: [row(1, { arrivalDate: '4/10' })], SG: [] } });
  assert.equal(ui.isOpen(), false);
  await ui.open(1);
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.text('vtDetailCode'), 'MA1');
  assert.equal(ui.text('vtDetailName'), 'Hàng 1');
  assert.equal(ui.text('vtDetailSubtitle'), 'VT Hà Nội');
  assert.equal(ui.text('vtDetailCartons'), '2');
  assert.equal(ui.text('vtDetailPieces'), '200');
  assert.equal(ui.text('vtDetailAvailable'), '150', 'Có thể bốc = SL chiếc − giữ chỗ (50)');
  assert.equal(ui.text('vtDetailKiot'), '350');
  assert.equal(ui.text('vtDetailStatLocation'), 'K1');
  assert.equal(ui.field('notes').value, '2T x 100');
  assert.equal(ui.field('arrivalDate').value, '4/10');
  assert.equal(ui.field('location').value, 'K1');
  assert.equal(ui.field('notes').readOnly, false);
});

test('chi tiết vị trí hiển thị tồn âm và tiếp tục trừ số đang giữ chỗ', async t => {
  const ui = await setup(t, { data: { HN: [row(1, { notes: '-2T x 100', quantity: -200, available: -250 })], SG: [] } });
  await ui.open(1);
  assert.equal(ui.text('vtDetailCartons'), '-2');
  assert.equal(ui.text('vtDetailPieces'), '-200');
  assert.equal(ui.text('vtDetailAvailable'), '-250');
  ui.type('notes', 'Hết hàng');
  assert.equal(ui.text('vtDetailAvailable'), '-50');
});

test('hàng ngoài Kiot không tự tính thông số trong hộp chi tiết kể cả khi đã đánh dấu Đã sửa', async t => {
  const ui = await setup(t, { data: { HN: [row(1, { quantity: null, available: null, kiotQuantity: null, rawWarnings: ['unknowncode'], warnings: [], acknowledged: true })], SG: [] } });
  await ui.open(1);
  for (const id of ['vtDetailCartons', 'vtDetailPieces', 'vtDetailAvailable', 'vtDetailKiot']) assert.equal(ui.text(id), '—');
  ui.type('notes', '3T x 100');
  for (const id of ['vtDetailCartons', 'vtDetailPieces', 'vtDetailAvailable']) assert.equal(ui.text(id), '—');
});

test('mở bằng Enter/Space trên dòng; đang bôi đen chữ thì bấm dòng không mở', async t => {
  const ui = await setup(t);
  const tr = ui.doc.querySelector('#vtRows tr[data-id="2"]');
  tr.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.text('vtDetailCode'), 'MA2');
  ui.doc.querySelector('#vtDetailDialog .dp-close').click();
  assert.equal(ui.isOpen(), false);
  tr.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(ui.isOpen(), true);
  ui.doc.querySelector('#vtDetailDialog .dp-close').click();
  ui.window.getSelection = () => ({ toString: () => 'MA2' });
  tr.click();
  assert.equal(ui.isOpen(), false, 'có chữ đang được chọn thì không mở');
  ui.window.getSelection = () => ({ toString: () => '' });
  tr.click();
  assert.equal(ui.isOpen(), true);
  await settle();
});

test('SL thùng / SL chiếc cập nhật khi gõ Ghi chú; sai định dạng thì "—" kèm huy hiệu cảnh báo', async t => {
  const ui = await setup(t);
  await ui.open(1);
  ui.type('notes', '3T x 50 + 1T x 20');
  assert.equal(ui.text('vtDetailCartons'), '4');
  assert.equal(ui.text('vtDetailPieces'), '170');
  assert.match(ui.text('vtDetailWarn'), /Nhiều quy cách/);
  ui.type('notes', 'hàng rác');
  assert.equal(ui.text('vtDetailCartons'), '—');
  assert.equal(ui.text('vtDetailPieces'), '—');
  const badge = ui.doc.querySelector('#vtDetailWarn .vt-badge');
  assert.ok(badge && badge.querySelector('.vt-badge-icon'));
  assert.match(badge.textContent, /Sai định dạng/);
  ui.type('notes', '5T x 10');
  assert.equal(ui.text('vtDetailCartons'), '5');
  assert.equal(ui.text('vtDetailWarn'), '', 'ghi chú hợp lệ thì không còn huy hiệu');
  ui.type('location', 'Z9');
  ui.type('arrivalDate', '1/11');
  assert.equal(ui.text('vtDetailStatLocation'), 'Z9');
  ui.type('location', '');
  assert.equal(ui.text('vtDetailStatLocation'), '—');
});

test('lịch sử của dòng gọi đúng URL positionId, hiện 4 cột (cũ gạch → mới) và tải thêm bằng before', async t => {
  const queries = [];
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/history') return null;
      queries.push(parsed.searchParams);
      return parsed.searchParams.get('before')
        ? json({ rows: [entry(5, { action: 'create', field: 'notes', oldValue: null, newValue: '1T x 100', actorName: 'Hà' })], nextBefore: null })
        : json({ rows: [entry(9), entry(8, { action: 'edit', field: 'location', oldValue: 'K0', newValue: 'K1', actorName: 'Minh' })], nextBefore: 8 });
    }
  });
  await ui.open(1);
  assert.equal(queries[0].get('branch'), 'HN');
  assert.equal(queries[0].get('positionId'), '1');
  assert.equal(queries[0].get('limit'), '50');
  assert.equal(queries[0].get('before'), null);
  const rows = [...ui.doc.querySelectorAll('#vtDetailHistoryRows tr')];
  assert.equal(rows.length, 2);
  assert.deepEqual([...rows[0].children].map(td => td.textContent), ['27/10/2026 10:00', 'Lan', 'Sửa', '1T x 100 → 2T x 100']);
  assert.equal(rows[0].querySelector('del.vt-hist-old').textContent, '1T x 100');
  assert.equal(rows[0].querySelector('ins.vt-hist-new').textContent, '2T x 100');
  assert.match(rows[1].textContent, /Vị trí: K0 → K1/);
  assert.equal(ui.doc.getElementById('vtDetailHistoryMore').hidden, false);
  ui.doc.getElementById('vtDetailHistoryMore').click();
  await settle();
  assert.equal(queries[1].get('before'), '8');
  assert.equal(queries[1].get('positionId'), '1');
  assert.equal(ui.doc.querySelectorAll('#vtDetailHistoryRows tr').length, 3);
  assert.equal(ui.doc.getElementById('vtDetailHistoryMore').hidden, true);
  assert.match(ui.text('vtDetailHistoryNote'), /3 thay đổi/);
});

test('lịch sử rỗng hoặc lỗi hiện thông báo trong bảng; mở dòng khác không lẫn lịch sử cũ', async t => {
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/history') return null;
      return parsed.searchParams.get('positionId') === '1' ? json({ rows: [] }) : json({ error: 'Lỗi tải', code: 'X' }, 500);
    }
  });
  await ui.open(1);
  assert.match(ui.text('vtDetailHistoryRows'), /Chưa có lịch sử cho dòng này/);
  ui.doc.querySelector('#vtDetailDialog .dp-close').click();
  await ui.open(2);
  assert.match(ui.text('vtDetailHistoryRows'), /Lỗi tải/);
});

test('ô Vị trí tự về dạng chuẩn khi rời ô (bỏ khoảng trắng, viết hoa: "a 05" -> "A05"), cả hộp chi tiết lẫn Thêm dòng', async t => {
  const ui = await setup(t);
  await ui.open(1);
  ui.type('location', ' a 05 ');
  ui.field('location').dispatchEvent(new ui.window.Event('blur'));
  assert.equal(ui.field('location').value, 'A05');
  const add = ui.doc.getElementById('vtAddForm').elements.location;
  add.value = 'kệ 1';
  add.dispatchEvent(new ui.window.Event('blur'));
  assert.equal(add.value, 'KỆ1');
});

test('Lưu gửi PATCH kèm đúng version chỉ các trường đã đổi, rồi đóng hộp và cập nhật dòng', async t => {
  let sent;
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      if (options.method === 'PATCH') { sent = { path: parsed.pathname, body: JSON.parse(options.body) }; return json({ row: row(1, { notes: '3T x 100', quantity: 300, location: 'K1', version: 4, updatedByName: 'Tôi' }) }); }
    }
  });
  await ui.open(1);
  ui.type('notes', '3T x 100');
  await ui.save();
  assert.equal(sent.path, '/api/stock-positions/1');
  assert.deepEqual(sent.body, { version: 3, notes: '3T x 100' }, 'chỉ gửi trường đã đổi');
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.doc.querySelector('#vtRows tr[data-id="1"] td[data-field="notes"]').textContent, '3T x 100');
  assert.equal(ui.doc.querySelector('#vtRows tr[data-id="1"] td[data-field="quantity"]').textContent, '300');
  assert.equal(ui.doc.querySelector('#vtRows tr[data-id="1"] td[data-field="updatedByName"]').textContent, 'Tôi');
  assert.match(ui.text('vtNotice'), /Đã lưu dòng MA1/);

  await ui.open(1);
  ui.type('location', 'B2');
  ui.type('arrivalDate', '9/9');
  await ui.save();
  assert.deepEqual(sent.body, { version: 4, arrivalDate: '9/9', location: 'B2' });
});

test('không đổi gì thì bấm Lưu chỉ đóng hộp, không gọi API', async t => {
  const ui = await setup(t);
  await ui.open(1);
  await ui.save();
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.calls.filter(c => c.method === 'PATCH').length, 0);
  await ui.open(1);
  ui.type('notes', '  2T x 100  ');
  await ui.save();
  assert.equal(ui.calls.filter(c => c.method === 'PATCH').length, 0, 'khoảng trắng thừa không tính là đổi');
});

test('Enter trong ô nhập lưu như bấm Lưu; xóa ô Ghi chú rồi gõ "+1t100" thì nối vào ghi chú cũ', async t => {
  const bodies = [];
  const ui = await setup(t, {
    handler: async (url, options) => {
      if (options.method !== 'PATCH') return null;
      bodies.push(JSON.parse(options.body));
      return json({ row: row(1, { notes: '2T x 100 +1t100', version: 4 }) });
    }
  });
  await ui.open(1);
  ui.type('notes', '+1t100');
  ui.field('notes').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].notes, '2T x 100 +1t100');
  assert.equal(ui.isOpen(), false);
});

test('ghi chú trống → 409 WOULD_AUTO_DELETE: hỏi xác nhận, đồng ý thì gửi lại confirmEmpty, bỏ dòng và có Hoàn tác; Hủy giữ hộp mở', async t => {
  const bodies = [];
  let created;
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        bodies.push(body);
        return body.confirmEmpty ? json({ deleted: true, id: 1 }) : json({ error: 'Hết hàng', code: 'WOULD_AUTO_DELETE' }, 409);
      }
      if (options.method === 'POST' && parsed.pathname === '/api/stock-positions') {
        created = JSON.parse(options.body);
        return json({ row: row(9, { notes: created.notes, location: created.location }) }, 201);
      }
    }
  });
  await ui.open(1);
  ui.type('notes', '');
  await ui.save();
  assert.ok(ui.doc.getElementById('vtConfirmDialog').hasAttribute('open'));
  ui.doc.getElementById('vtConfirmCancel').click();
  await settle();
  assert.equal(ui.isOpen(), true, 'Hủy thì hộp chi tiết vẫn mở');
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="1"]'));
  assert.equal(bodies.length, 1);

  await ui.save();
  ui.doc.getElementById('vtConfirmOk').click();
  await settle();
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].confirmEmpty, true);
  assert.equal(ui.doc.querySelector('#vtRows tr[data-id="1"]'), null);
  assert.equal(ui.isOpen(), false);
  const undo = ui.doc.getElementById('vtNotice').querySelector('.vt-undo');
  assert.ok(undo, 'có nút Hoàn tác');
  undo.click();
  await settle();
  assert.equal(created.notes, '2T x 100');
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="9"]'));
});

test('lỗi khi lưu hiện trong hộp (không đóng); 409 VERSION_CONFLICT báo, đóng hộp và tải lại danh sách', async t => {
  let answer = json({ error: 'Vị trí không hợp lệ.', code: 'VALIDATION' }, 400);
  const ui = await setup(t, { handler: async (url, options) => (options.method === 'PATCH' ? answer : null) });
  await ui.open(1);
  ui.type('location', '!!');
  await ui.save();
  assert.equal(ui.text('vtDetailError'), 'Vị trí không hợp lệ.');
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.doc.getElementById('vtDetailSave').disabled, false, 'có thể sửa và lưu lại');
  ui.type('location', 'K1x');
  assert.equal(ui.text('vtDetailError'), '', 'gõ tiếp thì xóa lỗi cũ');

  answer = json({ error: 'conflict', code: 'VERSION_CONFLICT' }, 409);
  await ui.save();
  assert.equal(ui.isOpen(), false);
  assert.match(ui.text('vtNotice'), /người khác sửa/);
  assert.equal(ui.calls.filter(c => c.method === 'GET' && c.path === '/api/stock-positions').length, 2);
});

test('Xóa dòng: hỏi xác nhận, DELETE kèm version, đóng hộp, bỏ dòng và có Hoàn tác; Hủy giữ nguyên', async t => {
  const seen = [];
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      seen.push({ method: options.method, path: parsed.pathname, query: parsed.searchParams });
      if (options.method === 'DELETE') return json({ deleted: true, id: 2 });
    }
  });
  await ui.open(2);
  ui.doc.getElementById('vtDetailDelete').click();
  await settle();
  assert.ok(ui.doc.getElementById('vtConfirmDialog').hasAttribute('open'));
  assert.match(ui.text('vtConfirmMessage'), /MA2/);
  ui.doc.getElementById('vtConfirmCancel').click();
  await settle();
  assert.equal(ui.isOpen(), true);
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="2"]'));
  assert.equal(seen.filter(call => call.method === 'DELETE').length, 0);

  ui.doc.getElementById('vtDetailDelete').click();
  await settle();
  ui.doc.getElementById('vtConfirmOk').click();
  await settle();
  const del = seen.find(call => call.method === 'DELETE');
  assert.equal(del.path, '/api/stock-positions/2');
  assert.equal(del.query.get('version'), '3');
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.doc.querySelector('#vtRows tr[data-id="2"]'), null);
  assert.ok(ui.doc.getElementById('vtNotice').querySelector('.vt-undo'));
});

test('xóa thất bại hiện lỗi trong hộp và giữ hộp mở', async t => {
  const ui = await setup(t, { handler: async (url, options) => (options.method === 'DELETE' ? json({ error: 'Không xóa được.', code: 'X' }, 500) : null) });
  await ui.open(1);
  ui.doc.getElementById('vtDetailDelete').click();
  await settle();
  ui.doc.getElementById('vtConfirmOk').click();
  await settle();
  assert.equal(ui.text('vtDetailError'), 'Không xóa được.');
  assert.equal(ui.isOpen(), true);
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="1"]'));
});

test('dấu × / Esc / Hủy đóng hộp; mở lại thì dữ liệu nhập dở bị bỏ', async t => {
  const ui = await setup(t);
  await ui.open(1);
  ui.doc.querySelector('#vtDetailDialog .dp-close').click();
  assert.equal(ui.isOpen(), false);
  await ui.open(1);
  assert.ok(ui.doc.querySelector('#vtDetailDialog .vt-detail-foot [data-vt-close]'), 'chân hộp có nút Hủy đóng hộp không lưu');
  await ui.open(1);
  ui.type('notes', 'nhập dở');
  ui.doc.getElementById('vtDetailDialog').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.isOpen(), false);
  await ui.open(1);
  assert.equal(ui.field('notes').value, '2T x 100');
  assert.equal(ui.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('chỉ xem: ô nhập chỉ đọc, ẩn Lưu và Xóa nhưng vẫn thấy thông số và lịch sử; Lưu/Xóa không làm gì', async t => {
  const queries = [];
  const ui = await setup(t, {
    canEdit: false,
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/history') return null;
      queries.push(parsed.searchParams);
      return json({ rows: [entry(1)], nextBefore: null });
    }
  });
  await ui.open(1);
  assert.equal(ui.field('notes').readOnly, true);
  assert.equal(ui.field('location').readOnly, true);
  assert.equal(ui.doc.getElementById('vtDetailSave').hidden, true);
  assert.equal(ui.doc.getElementById('vtDetailDelete').hidden, true);
  assert.equal(ui.text('vtDetailCartons'), '2');
  assert.equal(queries.length, 1);
  assert.equal(ui.doc.querySelectorAll('#vtDetailHistoryRows tr').length, 1);
  ui.field('notes').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(ui.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('mã ở tab Sài Gòn: tiêu đề phụ và URL lịch sử theo SG', async t => {
  const queries = [];
  const ui = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname === '/api/stock-positions/history') { queries.push(parsed.searchParams); return json({ rows: [], nextBefore: null }); }
      return null;
    }
  });
  const changed = new Promise(resolve => ui.window.addEventListener('hashchange', resolve, { once: true }));
  ui.window.location.hash = 'sg';
  await changed;
  await settle();
  await ui.open(3);
  assert.equal(ui.text('vtDetailSubtitle'), 'VT Sài Gòn');
  assert.equal(queries[0].get('branch'), 'SG');
  assert.equal(queries[0].get('positionId'), '3');
});
