'use strict';
// Xóa / Cắt / Dán vào vùng ô đang chọn (table-controls.js) — kiểu Excel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8');

const readOnly = '<table id="t"><thead><tr><th>Mã</th><th>SL</th></tr></thead><tbody>'
  + '<tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>';
// 3 dòng × 3 cột: cột 0 chữ thuần, cột 1 ô input, cột 2 textarea.
const editable = '<table id="t"><thead><tr><th>Mã</th><th>Tên</th><th>Ghi chú</th></tr></thead><tbody>'
  + [1, 2, 3].map(n => `<tr><td>M${n}</td><td><input value="ten${n}"></td><td><textarea>gc${n}</textarea></td></tr>`).join('')
  + '</tbody></table>';

async function setup(t, html) {
  const dom = new JSDOM(html, { url: 'https://tables.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(source);
  if (dom.window.document.readyState === 'loading') await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const doc = dom.window.document, win = dom.window;
  const ctx = { window: win, doc, api: win.TKSTables, table: doc.querySelector('table'), events: [] };
  ctx.cell = (row, col) => ctx.table.tBodies[0].rows[row].cells[col];
  ctx.mouse = (type, target, init = {}) => target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...init }));
  ctx.drag = (from, to) => {
    ctx.mouse('mousedown', ctx.cell(...from));
    ctx.mouse('mousemove', ctx.cell(...to));
    ctx.mouse('mouseup', ctx.cell(...to));
  };
  ctx.key = (key, init = {}, target = doc) => {
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  ctx.paste = text => {
    const event = new win.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    doc.dispatchEvent(event);
    return event;
  };
  ctx.cut = () => {
    const data = {};
    const event = new win.Event('cut', { bubbles: true, cancelable: true });
    event.clipboardData = { setData: (type, value) => { data[type] = value; } };
    doc.dispatchEvent(event);
    return { event, data };
  };
  ctx.bar = () => doc.querySelector('.tks-sel-sum');
  ctx.input = (row, col) => ctx.cell(row, col).querySelector('input,textarea');
  return ctx;
}

test('parseClipboardTable hiểu TSV, ô bọc ngoặc kép có xuống dòng / tab / ngoặc kép', async t => {
  const ctx = await setup(t, readOnly);
  const parse = text => JSON.parse(JSON.stringify(ctx.api.parseClipboardTable(text))); // mảng của realm jsdom → realm Node
  assert.deepEqual(parse('a\tb\nc\td\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parse('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parse('"x\ny"\t"p""q"\t"t\tt"'), [['x\ny', 'p"q', 't\tt']]);
  assert.deepEqual(parse('a\t\tc'), [['a', '', 'c']]);
  assert.deepEqual(parse(''), []);
});

test('bảng chỉ xem: Delete không đổi chữ, báo "chỉ để xem"', async t => {
  const ctx = await setup(t, readOnly);
  ctx.drag([0, 0], [1, 1]);
  const event = ctx.key('Delete');
  assert.equal(event.defaultPrevented, true);
  assert.equal(ctx.cell(0, 0).textContent, 'A');
  assert.match(ctx.bar().textContent, /chỉ để xem/);
});

test('Delete và Backspace xóa nội dung input / textarea trong vùng chọn và bắn input + change', async t => {
  const ctx = await setup(t, editable);
  const fired = [];
  ctx.table.addEventListener('change', e => fired.push(e.target.value));
  ctx.drag([0, 1], [1, 2]);
  ctx.key('Delete');
  assert.deepEqual([ctx.input(0, 1).value, ctx.input(0, 2).value, ctx.input(1, 1).value, ctx.input(1, 2).value], ['', '', '', '']);
  assert.equal(ctx.input(2, 1).value, 'ten3'); // ngoài vùng chọn
  assert.equal(ctx.cell(0, 0).textContent, 'M1'); // cột chữ thuần không đụng
  assert.equal(fired.length, 4);
  assert.match(ctx.bar().textContent, /Đã xóa 4 ô/);

  ctx.drag([2, 1], [2, 1]);
  ctx.key('Backspace');
  assert.equal(ctx.input(2, 1).value, '');
});

test('ô lẫn chữ thuần: xóa được ô nhập, báo bỏ qua ô chỉ xem', async t => {
  const ctx = await setup(t, editable);
  ctx.drag([0, 0], [0, 1]);
  ctx.key('Delete');
  assert.equal(ctx.cell(0, 0).textContent, 'M1');
  assert.equal(ctx.input(0, 1).value, '');
  assert.match(ctx.bar().textContent, /Đã xóa 1 ô · bỏ qua 1 ô không sửa được/);
});

test('đang gõ trong ô input thì Delete/Backspace/dán là của ô đó, không đụng vùng chọn', async t => {
  const ctx = await setup(t, editable);
  ctx.drag([0, 0], [1, 2]);
  ctx.input(2, 1).focus();
  assert.equal(ctx.key('Delete', {}, ctx.input(2, 1)).defaultPrevented, false);
  assert.equal(ctx.paste('zzz').defaultPrevented, false);
  assert.equal(ctx.input(0, 1).value, 'ten1');
});

test('Ctrl+X chép TSV rồi xóa vùng chọn', async t => {
  const ctx = await setup(t, editable);
  ctx.drag([0, 1], [1, 2]);
  const { event, data } = ctx.cut();
  assert.equal(event.defaultPrevented, true);
  assert.equal(data['text/plain'], 'ten1\tgc1\nten2\tgc2');
  assert.equal(ctx.input(0, 1).value, '');
  assert.equal(ctx.input(1, 2).value, '');
});

test('dán khối TSV từ ô trên-trái của vùng chọn, ô thừa ngoài bảng bị bỏ', async t => {
  const ctx = await setup(t, editable);
  ctx.drag([1, 1], [1, 1]);
  const event = ctx.paste('a\tb\nc\td\ne\tf\n'); // 3 dòng × 2 cột, nhưng chỉ còn dòng 1..2
  assert.equal(event.defaultPrevented, true);
  assert.equal(ctx.input(1, 1).value, 'a');
  assert.equal(ctx.input(1, 2).value, 'b');
  assert.equal(ctx.input(2, 1).value, 'c');
  assert.equal(ctx.input(2, 2).value, 'd');
  assert.equal(ctx.input(0, 1).value, 'ten1');
  const sel = ctx.api.getSelection();
  assert.equal(sel.cells.length, 4); // vùng chọn nhảy sang đúng khối vừa dán
  assert.match(ctx.bar().textContent, /Đã dán 4 ô/);
});

test('dán 1 giá trị vào vùng nhiều ô thì điền đầy cả vùng', async t => {
  const ctx = await setup(t, editable);
  ctx.drag([0, 1], [2, 1]);
  ctx.paste('X');
  assert.deepEqual([0, 1, 2].map(r => ctx.input(r, 1).value), ['X', 'X', 'X']);
  assert.equal(ctx.input(0, 2).value, 'gc1');
});

test('dán bỏ qua cột đang ẩn và nhảy sang cột hiện kế tiếp', async t => {
  const ctx = await setup(t, editable);
  ctx.table.tBodies[0].querySelectorAll('tr').forEach(row => row.cells[1].classList.add('tks-column-hidden'));
  ctx.drag([0, 0], [0, 0]);
  ctx.paste('p\tq\tr');
  assert.equal(ctx.input(0, 1).value, 'ten1'); // cột ẩn giữ nguyên
  assert.equal(ctx.input(0, 2).value, 'q'); // cột 0 nhận p (chữ thuần, bỏ qua), cột 2 nhận q, r hết chỗ
});

test('dán vào select khớp theo value hoặc chữ hiển thị, không khớp thì bỏ qua', async t => {
  const html = '<table><thead><tr><th>Mã</th><th>TT</th></tr></thead><tbody>'
    + '<tr><td>A</td><td><select><option value="">—</option><option value="ok">Đã duyệt</option><option value="no">Từ chối</option></select></td></tr>'
    + '<tr><td>B</td><td><select><option value="">—</option><option value="ok">Đã duyệt</option><option value="no">Từ chối</option></select></td></tr></tbody></table>';
  const ctx = await setup(t, html);
  const sel = (r) => ctx.cell(r, 1).querySelector('select');
  ctx.drag([0, 1], [1, 1]);
  ctx.paste('đã duyệt\nkhông có');
  assert.equal(sel(0).value, 'ok');
  assert.equal(sel(1).value, ''); // không khớp: giữ nguyên
  assert.match(ctx.bar().textContent, /Đã dán 1 ô · bỏ qua 1 ô/);
  ctx.drag([0, 1], [0, 1]);
  ctx.key('Delete');
  assert.equal(sel(0).value, '');
});

test('input số nhận số có dấu phẩy ngăn nghìn, chữ thì từ chối', async t => {
  const html = '<table><thead><tr><th>SL</th></tr></thead><tbody><tr><td><input type="number" value="1"></td></tr><tr><td><input type="number" value="2"></td></tr></tbody></table>';
  const ctx = await setup(t, html);
  ctx.drag([0, 0], [1, 0]);
  ctx.paste('1,234\nabc');
  assert.equal(ctx.input(0, 0).value, '1234');
  assert.equal(ctx.input(1, 0).value, '2');
});

test('input readonly / disabled không bị ghi', async t => {
  const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><input value="r" readonly></td><td><input value="d" disabled></td></tr></tbody></table>';
  const ctx = await setup(t, html);
  ctx.drag([0, 0], [0, 1]);
  ctx.key('Delete');
  assert.equal(ctx.input(0, 0).value, 'r');
  assert.equal(ctx.cell(0, 1).querySelector('input').value, 'd');
  assert.match(ctx.bar().textContent, /chỉ để xem/);
});

test('trang tự xử lý qua tks:cells-edit: ô được nhận không bị ghi đè bởi bước tự động, chờ được Promise pending', async t => {
  const html = '<table><thead><tr><th>Mã</th><th>Vị trí</th></tr></thead><tbody>'
    + '<tr><td>A</td><td data-cell-editable>X1</td></tr><tr><td>B</td><td data-cell-editable>X2</td></tr></tbody></table>';
  const ctx = await setup(t, html);
  const seen = [];
  ctx.table.tBodies[0].addEventListener('tks:cells-edit', event => {
    const { action, edits, pending } = event.detail;
    seen.push(action);
    edits.forEach(edit => {
      if (!edit.cell.hasAttribute('data-cell-editable')) return;
      edit.handled = true;
      if (edit.row === 1) edit.cancelled = true; // người dùng từ chối dòng này
      else edit.cell.textContent = edit.value;
    });
    pending.push(new Promise(resolve => setTimeout(resolve, 5)));
  });
  ctx.drag([0, 0], [1, 1]);
  ctx.paste('m1\tv1\nm2\tv2');
  assert.deepEqual(seen, ['paste']);
  assert.equal(ctx.cell(0, 1).textContent, 'v1');
  assert.equal(ctx.cell(0, 0).textContent, 'A'); // cột chữ thuần không nhận
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(ctx.bar().textContent, /Đã dán 1 ô · bỏ qua 3 ô/);
});

test('hơn 20 ô sửa được: hỏi xác nhận, từ chối thì không đổi gì', async t => {
  const rows = Array.from({ length: 25 }, (_, i) => `<tr><td><input value="v${i}"></td></tr>`).join('');
  const ctx = await setup(t, `<table><thead><tr><th>A</th></tr></thead><tbody>${rows}</tbody></table>`);
  const asked = [];
  ctx.window.confirm = message => { asked.push(message); return false; };
  ctx.drag([0, 0], [24, 0]);
  ctx.key('Delete');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /25 ô/);
  assert.equal(ctx.input(0, 0).value, 'v0');
  ctx.window.confirm = () => true;
  ctx.key('Delete');
  assert.equal(ctx.input(0, 0).value, '');
  assert.equal(ctx.input(24, 0).value, '');
});

test('không có vùng chọn thì Delete / dán không làm gì', async t => {
  const ctx = await setup(t, editable);
  assert.equal(ctx.key('Delete').defaultPrevented, false);
  assert.equal(ctx.paste('x').defaultPrevented, false);
  assert.equal(ctx.input(0, 1).value, 'ten1');
});

test('bảng data-table-select="off" giữ nguyên bộ xử lý riêng', async t => {
  const ctx = await setup(t, editable.replace('<table id="t">', '<table id="t" data-table-select="off">'));
  ctx.mouse('mousedown', ctx.cell(0, 0));
  ctx.mouse('mouseup', ctx.cell(0, 0));
  assert.equal(ctx.key('Delete').defaultPrevented, false);
});
