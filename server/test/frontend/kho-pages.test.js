'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '../../public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const pageOf = file => new JSDOM(read(file)).window.document;

// Thứ tự yêu cầu: tổng thể → A → B (Kho chính nhỏ) → B (Sân trước) → C → F → K → P1 → P2 → V.
const IMAGES = [
  '00-tong-the.jpg', '01-A-kho-chinh-to.jpg', '02-B-kho-chinh-nho.jpg', '03-B-san-truoc.jpg', '04-C-san-sau.jpg',
  '05-F-san-ton-mat.jpg', '06-K-kho-dua.jpg', '07-P1-kho-8-truoc.jpg', '08-P2-kho-8-sau.jpg', '09-V-kho-vin.jpg'
];

test('Kho Hà Nội: đủ 10 ảnh đúng thứ tự, mỗi ảnh có file thật', () => {
  const doc = pageOf('kho-hn/index.html');
  const imgs = [...doc.querySelectorAll('img[data-kho-img]')];
  assert.equal(imgs.length, 10);
  assert.deepEqual(imgs.map(img => path.posix.basename(img.getAttribute('src').split('?')[0])), IMAGES);
  for (const name of IMAGES) {
    const file = path.join(publicDir, 'kho-hn/img', name);
    assert.ok(fs.existsSync(file), name);
    assert.ok(fs.statSync(file).size > 10000, name);
  }
  for (const img of imgs) assert.ok(img.getAttribute('alt'), 'ảnh phải có alt');
});

test('Kho Hà Nội: hàng chip A, B, B-Sân trước, C, F, K, P1, P2, V', () => {
  const doc = pageOf('kho-hn/index.html');
  const chips = [...doc.querySelectorAll('[data-kho-chip]')];
  assert.deepEqual(chips.map(chip => chip.textContent.trim()), ['A', 'B', 'B-Sân trước', 'C', 'F', 'K', 'P1', 'P2', 'V']);
});

test('Kho Hà Nội: dùng biến CSS của dự án, responsive, không phụ thuộc framework', () => {
  const html = read('kho-hn/index.html');
  assert.match(html, /\/shared\/shared\.css/);
  assert.match(html, /id="sidebar"[^>]*data-tks-active-top="stockLocations"/);
  assert.doesNotMatch(html, /tailwind|react|vue/i);
  const css = read('kho/kho.css');
  assert.match(css, /var\(--/);
  assert.match(css, /@media/);
});

test('Kho Sài Gòn: trang trống có tiêu đề và dòng "Chưa có sơ đồ kho", chưa có ảnh', () => {
  const doc = pageOf('kho-sg/index.html');
  assert.match(doc.title, /Kho Sài Gòn/);
  assert.match(doc.body.textContent, /Chưa có sơ đồ kho/);
  assert.equal(doc.querySelectorAll('img[data-kho-img]').length, 0);
  assert.match(read('kho-sg/index.html'), /id="sidebar"[^>]*data-tks-active-top="stockLocations"/);
});

// Phóng to ảnh: lướt/mũi tên/nút chuyển sang ảnh khác, vòng tròn, Esc đóng.
async function loadKho(file) {
  const dom = new JSDOM(read(file), { url: 'https://tokosi.test/' + file.split('/')[0] + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.TKSNav = { authGuard: async () => ({}), renderTopSidebar() {} };
  window.eval(read('kho/kho.js'));
  await window.TKSKho.init();
  return window;
}
const zoomState = window => {
  const zoom = window.document.getElementById('khoZoom');
  return { open: !zoom.hidden, src: zoom.querySelector('img').getAttribute('src'), caption: window.document.getElementById('khoZoomCaption').textContent };
};
const swipe = (window, dx, dy = 0) => {
  const zoom = window.document.getElementById('khoZoom');
  const touchEvent = (type, x, y, list) => {
    const event = new window.Event(type, { bubbles: true });
    event.touches = type === 'touchend' ? [] : list;
    event.changedTouches = list;
    zoom.dispatchEvent(event);
  };
  touchEvent('touchstart', 200, 300, [{ clientX: 200, clientY: 300 }]);
  touchEvent('touchend', 200 + dx, 300 + dy, [{ clientX: 200 + dx, clientY: 300 + dy }]);
};
const key = (window, name) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));

test('Phóng to ảnh: mở đúng ảnh, mũi tên / nút trước-sau chuyển ảnh, vòng tròn, Esc đóng', async () => {
  const window = await loadKho('kho-hn/index.html');
  const doc = window.document;
  const imgs = [...doc.querySelectorAll('img[data-kho-img]')];
  imgs[2].click();
  let state = zoomState(window);
  assert.equal(state.open, true);
  assert.match(state.src, /02-B-kho-chinh-nho\.jpg/);
  assert.match(state.caption, /Kho chính nhỏ – B · 3\/10/);
  key(window, 'ArrowRight');
  assert.match(zoomState(window).src, /03-B-san-truoc\.jpg/);
  key(window, 'ArrowLeft'); key(window, 'ArrowLeft');
  assert.match(zoomState(window).src, /01-A-kho-chinh-to\.jpg/);
  doc.querySelector('[data-kho-next]').click();
  assert.match(zoomState(window).src, /02-B-kho-chinh-nho\.jpg/);
  doc.querySelector('[data-kho-prev]').click();
  assert.equal(zoomState(window).open, true, 'bấm nút trước/sau không đóng hộp');
  key(window, 'ArrowLeft'); key(window, 'ArrowLeft');
  assert.match(zoomState(window).src, /09-V-kho-vin\.jpg/, 'từ ảnh đầu lùi lại quay về ảnh cuối');
  key(window, 'ArrowRight');
  assert.match(zoomState(window).caption, /Sơ đồ tổng thể · 1\/10/);
  key(window, 'Escape');
  assert.equal(zoomState(window).open, false);
  window.close();
});

test('Phóng to ảnh: lướt trái = ảnh sau, lướt phải = ảnh trước; lướt dọc hoặc ngắn thì bỏ qua', async () => {
  const window = await loadKho('kho-hn/index.html');
  window.document.querySelectorAll('img[data-kho-img]')[1].click();
  swipe(window, -120);
  assert.match(zoomState(window).src, /02-B-kho-chinh-nho\.jpg/);
  swipe(window, 120);
  swipe(window, 120);
  assert.match(zoomState(window).src, /00-tong-the\.jpg/);
  swipe(window, -20);
  swipe(window, -100, 150);
  assert.match(zoomState(window).src, /00-tong-the\.jpg/, 'lướt ngắn hoặc chéo/dọc không đổi ảnh');
  assert.equal(zoomState(window).open, true);
  window.close();
});
