'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8');
const fixture = '<table id="t"><thead><tr><th>Mã</th><th>SL</th><th>Tiền</th><th>Tỷ lệ</th></tr></thead><tbody>'
  + '<tr><td>A</td><td>1</td><td>1,000</td><td>10%</td></tr>'
  + '<tr><td>B</td><td>2</td><td>2,500</td><td>20%</td></tr>'
  + '<tr><td>C</td><td>3</td><td>—</td><td>30%</td></tr>'
  + '<tr><td>D</td><td>4</td><td>4,000</td><td>40%</td></tr>'
  + '</tbody><tfoot><tr><td>Tổng</td><td>10</td><td>7,500</td><td></td></tr></tfoot></table>'
  + '<p id="outside">ngoài bảng</p>';

async function setup(t, html = fixture) {
  const dom = new JSDOM(html, { url: 'https://tables.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(source);
  // start() (gắn listener) chạy ở DOMContentLoaded: đợi jsdom xong việc đó.
  if (dom.window.document.readyState === 'loading') await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const doc = dom.window.document;
  const ctx = { window: dom.window, doc, api: dom.window.TKSTables, table: doc.querySelector('table') };
  ctx.cell = (row, col) => ctx.table.tBodies[0].rows[row].cells[col];
  ctx.mouse = (type, target, init = {}) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...init }));
  // Kéo từ ô (r1,c1) tới ô (r2,c2); modifiers = { ctrlKey, shiftKey }.
  ctx.drag = (from, to, mods = {}) => {
    ctx.mouse('mousedown', ctx.cell(...from), mods);
    ctx.mouse('mousemove', ctx.cell(...to), mods);
    ctx.mouse('mouseup', ctx.cell(...to), mods);
  };
  ctx.selected = () => {
    const state = ctx.api.getSelection();
    return state ? Array.from(state.cells, cell => cell.textContent) : []; // Array.from: mảng của realm Node, deepEqual không lệch prototype
  };
  ctx.bar = () => doc.querySelector('.tks-sel-sum');
  return ctx;
}

test('kéo chuột chọn khối hàng × cột và hiện Tổng · Trung bình · Đếm', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [1, 2]); // SL 1,2 và Tiền 1,000 / 2,500
  assert.deepEqual(ctx.selected().sort(), ['1', '1,000', '2', '2,500']);
  assert.ok(ctx.cell(0, 1).classList.contains('tks-cell-selected'));
  assert.ok(!ctx.cell(2, 1).classList.contains('tks-cell-selected'));
  const bar = ctx.bar();
  assert.equal(bar.hidden, false);
  assert.match(bar.textContent, /Tổng: 3,503/);
  assert.match(bar.textContent, /Trung bình: 875\.75/);
  assert.match(bar.textContent, /Đếm: 4/);
});

test('chọn ngược hướng (từ dưới lên, phải sang trái) vẫn ra cùng khối', async t => {
  const ctx = await setup(t);
  ctx.drag([2, 1], [0, 0]);
  assert.deepEqual(ctx.selected().sort(), ['1', '2', '3', 'A', 'B', 'C']);
});

test('ô trống / dấu — không tính vào Đếm; cột % không cộng vào Tổng', async t => {
  const ctx = await setup(t);
  ctx.drag([1, 2], [2, 3]); // 2,500 · 20% · — · 30%
  const text = ctx.bar().textContent;
  assert.match(text, /Tổng: 2,500/);
  assert.match(text, /Đếm: 3/);
});

test('cột toàn chữ chỉ có Đếm, không có Tổng', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 0], [3, 0]);
  assert.doesNotMatch(ctx.bar().textContent, /Tổng/);
  assert.match(ctx.bar().textContent, /Đếm: 4/);
});

test('Ctrl+kéo thêm vùng thứ hai rời nhau và cộng gộp cả hai', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [0, 1]);
  ctx.drag([0, 1], [1, 1]); // vùng 1: SL 1,2
  ctx.drag([3, 1], [3, 2], { ctrlKey: true }); // vùng 2: SL 4 và Tiền 4,000
  const state = ctx.api.getSelection();
  assert.equal(state.regions, 2);
  assert.deepEqual(ctx.selected().sort(), ['1', '2', '4', '4,000']);
  assert.ok(!ctx.cell(2, 1).classList.contains('tks-cell-selected'), 'ô giữa hai vùng không được chọn');
  assert.match(ctx.bar().textContent, /Tổng: 4,007/);
});

test('không Ctrl thì kéo mới thay vùng cũ', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [1, 1]);
  ctx.drag([2, 1], [3, 1]);
  assert.deepEqual(ctx.selected().sort(), ['3', '4']);
  assert.equal(ctx.api.getSelection().regions, 1);
});

test('Ctrl+bấm thêm từng ô; Ctrl+bấm lại ô đó bỏ chọn ô', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [0, 1]);
  ctx.drag([2, 1], [2, 1], { ctrlKey: true });
  assert.deepEqual(ctx.selected().sort(), ['1', '3']);
  assert.match(ctx.bar().textContent, /Tổng: 4/);
  ctx.drag([2, 1], [2, 1], { ctrlKey: true });
  assert.deepEqual(ctx.selected(), ['1']);
  assert.equal(ctx.bar().hidden, true, 'còn 1 ô: ẩn thanh tổng');
});

test('Shift+bấm nối dài khối từ ô neo', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 0], [0, 0]);
  ctx.drag([2, 1], [2, 1], { shiftKey: true });
  assert.deepEqual(ctx.selected().sort(), ['1', '2', '3', 'A', 'B', 'C']);
});

test('chỉ bấm một ô: chọn đúng ô đó, chưa có thanh tổng', async t => {
  const ctx = await setup(t);
  ctx.drag([1, 2], [1, 2]);
  assert.deepEqual(ctx.selected(), ['2,500']);
  assert.ok(!ctx.bar() || ctx.bar().hidden);
});

test('kéo trong cùng một ô để bôi đen chữ: không khoá bôi đen, không chặn click', async t => {
  const ctx = await setup(t);
  const cell = ctx.cell(0, 0);
  ctx.mouse('mousedown', cell);
  ctx.mouse('mousemove', cell);
  assert.equal(ctx.doc.body.classList.contains('tks-selecting'), false);
  ctx.mouse('mouseup', cell);
  let clicked = 0;
  ctx.doc.addEventListener('click', () => { clicked += 1; });
  cell.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  assert.equal(clicked, 1);
});

test('kéo qua nhiều ô thì nuốt cú click ngay sau đó (không mở chi tiết dòng)', async t => {
  const ctx = await setup(t);
  let clicked = 0;
  ctx.table.addEventListener('click', () => { clicked += 1; });
  ctx.drag([0, 0], [1, 1]);
  ctx.cell(1, 1).dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(clicked, 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  ctx.cell(1, 1).dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(clicked, 1, 'click bình thường về sau vẫn chạy');
  assert.equal(ctx.doc.body.classList.contains('tks-selecting'), false);
});

test('bấm vào nút / ô nhập / liên kết trong ô không bắt đầu chọn vùng', async t => {
  const ctx = await setup(t, '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><button id="b">Sửa</button></td><td><input id="i" value="5"></td></tr><tr><td><a href="#x" id="l">Link</a></td><td>7</td></tr></tbody></table>');
  for (const id of ['b', 'i', 'l']) ctx.mouse('mousedown', ctx.doc.getElementById(id));
  assert.equal(ctx.api.getSelection(), null);
});

test('bảng data-table-select="off" (vd Kiểm kê) bị bỏ qua', async t => {
  const ctx = await setup(t, fixture.replace('<table id="t">', '<table id="t" data-table-select="off">'));
  ctx.drag([0, 0], [1, 1]);
  assert.equal(ctx.api.getSelection(), null);
  assert.equal(ctx.table.querySelector('.tks-cell-selected'), null);
});

test('bảng không bật bộ điều khiển cột (data-table-controls="off") vẫn chọn được', async t => {
  const ctx = await setup(t, fixture.replace('<table id="t">', '<table id="t" data-table-controls="off">'));
  ctx.drag([0, 0], [1, 1]);
  assert.equal(ctx.selected().length, 4);
});

test('tiêu đề và chân bảng không phải ô dữ liệu: bấm vào đó bỏ chọn', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [1, 1]);
  assert.equal(ctx.selected().length, 2);
  ctx.mouse('mousedown', ctx.table.tFoot.rows[0].cells[0]);
  assert.equal(ctx.api.getSelection(), null);
  assert.equal(ctx.table.querySelector('.tks-cell-selected'), null);
});

test('Esc và bấm ra ngoài bảng bỏ chọn, thanh tổng ẩn', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 1], [1, 1]);
  ctx.doc.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ctx.api.getSelection(), null);
  assert.equal(ctx.bar().hidden, true);
  ctx.drag([0, 1], [1, 1]);
  ctx.mouse('mousedown', ctx.doc.getElementById('outside'));
  assert.equal(ctx.api.getSelection(), null);
  assert.equal(ctx.table.querySelector('.tks-cell-selected'), null);
});

test('Ctrl+A chọn toàn bộ thân bảng khi đã có vùng chọn', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 0], [0, 1]);
  const event = new ctx.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
  ctx.doc.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(ctx.selected().length, 16);
});

test('Ctrl+C chép khối dạng TSV (cột ẩn bị bỏ qua, nhiều vùng nối nhau)', async t => {
  const ctx = await setup(t);
  ctx.cell(0, 1).classList.add('tks-column-hidden');
  ctx.cell(1, 1).classList.add('tks-column-hidden');
  ctx.drag([0, 0], [1, 2]);
  const data = {};
  const copy = new ctx.window.Event('copy', { bubbles: true, cancelable: true });
  copy.clipboardData = { setData: (type, value) => { data[type] = value; } };
  ctx.doc.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  assert.equal(data['text/plain'], 'A\t1,000\nB\t2,500');
  ctx.drag([3, 0], [3, 0], { ctrlKey: true });
  const second = new ctx.window.Event('copy', { bubbles: true, cancelable: true });
  second.clipboardData = { setData: (type, value) => { data[type] = value; } };
  ctx.doc.dispatchEvent(second);
  assert.equal(data['text/plain'], 'A\t1,000\nB\t2,500\nD');
});

test('đang gõ trong ô nhập thì Ctrl+C và Ctrl+A để trình duyệt xử lý', async t => {
  const ctx = await setup(t, fixture + '<input id="box">');
  ctx.drag([0, 0], [1, 1]);
  const box = ctx.doc.getElementById('box');
  box.focus();
  const copy = new ctx.window.Event('copy', { bubbles: true, cancelable: true });
  copy.clipboardData = { setData() { throw new Error('không được ghi clipboard'); } };
  box.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, false);
  const selectAll = new ctx.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
  box.dispatchEvent(selectAll);
  assert.equal(selectAll.defaultPrevented, false);
});

test('trang vẽ lại hoặc lọc bớt dòng thì vùng chọn cũ bị bỏ', async t => {
  const ctx = await setup(t);
  ctx.drag([0, 0], [1, 1]);
  assert.equal(ctx.selected().length, 4);
  ctx.table.tBodies[0].rows[3].hidden = true; // lọc ẩn bớt dòng
  ctx.api.refreshAll();
  assert.equal(ctx.api.getSelection(), null);
  assert.equal(ctx.bar().hidden, true);

  const again = await setup(t);
  again.drag([0, 0], [1, 1]);
  again.table.tBodies[0].innerHTML = '<tr><td>X</td><td>9</td><td>9</td><td>9</td></tr>';
  again.api.refreshAll();
  assert.equal(again.api.getSelection(), null);
});

test('thanh tổng nằm trong hộp thoại đang mở để không bị lớp phủ che', async t => {
  const ctx = await setup(t, '<dialog open><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></dialog>');
  ctx.drag([0, 0], [1, 1]);
  assert.equal(ctx.bar().parentElement.tagName, 'DIALOG');
  assert.match(ctx.bar().textContent, /Tổng: 10/);
});

test('chỉ thả chuột sau khi giữ nút ngoài cửa sổ (buttons=0) cũng kết thúc lượt kéo', async t => {
  const ctx = await setup(t);
  ctx.mouse('mousedown', ctx.cell(0, 0));
  ctx.mouse('mousemove', ctx.cell(1, 1));
  assert.equal(ctx.doc.body.classList.contains('tks-selecting'), true);
  ctx.mouse('mousemove', ctx.cell(2, 2), { buttons: 0 });
  assert.equal(ctx.doc.body.classList.contains('tks-selecting'), false);
});
