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
