'use strict';

// Quy uoc bieu tuong sap xep chung moi bang: chua sap ▲▼ · tang dan ▼ · giam dan ▲, bieu tuong dinh MEP PHAI o tieu de
// (khong theo duoi chu). Phan hinh thuc (vi tri, mau, nut) nam duy nhat trong shared/shared.css.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const NONE = '▲▼';
const ASC = '▼';
const DESC = '▲';

function loadHtml(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'public', relativePath), 'utf8');
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
}

function createPage(relativePath, url) {
  const html = loadHtml(relativePath);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart { destroy() {} };
  dom.window.Chart.defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = () => 1;
  dom.window.TKSNav = {
    authGuard: () => new Promise(() => {}),
    handleBranchError: () => false,
    renderTopSidebar() {}
  };
  dom.window.fetch = () => new Promise(() => {});
  inlineScripts(html).forEach(script => dom.window.eval(script));
  return dom;
}

test('cac bang dashboard: chua sap ▲▼, tang dan ▼, giam dan ▲, bam lan 3 bo sap xep', () => {
  const dom = createPage('index.html', 'https://tokosi.example/');
  const indicator = dom.window.document.querySelector('.sort-indicator');
  const button = indicator.closest('button');
  const th = indicator.closest('th');

  assert.equal(indicator.textContent, NONE);
  assert.equal(th.getAttribute('aria-sort'), 'none');
  button.click();
  assert.equal(indicator.textContent, ASC);
  assert.equal(th.getAttribute('aria-sort'), 'ascending');
  button.click();
  assert.equal(indicator.textContent, DESC);
  assert.equal(th.getAttribute('aria-sort'), 'descending');
  button.click();
  assert.equal(indicator.textContent, NONE);
  assert.equal(th.getAttribute('aria-sort'), 'none');

  dom.window.close();
});

test('bang nghi phep: cung quy uoc bieu tuong', () => {
  const dom = createPage('humanresources/index.html', 'https://tokosi.example/humanresources/');
  dom.window.initSortableTables();
  const indicator = dom.window.document.querySelector('.sort-indicator');
  const button = indicator.closest('button');

  assert.equal(indicator.textContent, NONE);
  button.click();
  assert.equal(indicator.textContent, ASC);
  button.click();
  assert.equal(indicator.textContent, DESC);

  dom.window.close();
});

test('bang nguoi dung: cung quy uoc bieu tuong, nhan nam trong .sort-label', () => {
  const dom = createPage('account/index.html', 'https://tokosi.example/account/');
  const icon = dom.window.document.getElementById('sort-hoTen');
  const th = icon.closest('th');

  assert.equal(icon.className, 'sort-indicator');
  assert.equal(th.querySelector('.sort-label').textContent, 'Họ và tên');
  dom.window.handleSort('hoTen');
  assert.equal(icon.textContent, ASC);
  assert.equal(th.getAttribute('aria-sort'), 'ascending');
  dom.window.handleSort('hoTen');
  assert.equal(icon.textContent, DESC);
  assert.equal(th.getAttribute('aria-sort'), 'descending');
  dom.window.handleSort('hoTen');
  assert.equal(icon.textContent, NONE);
  assert.equal(th.getAttribute('aria-sort'), 'none');
  // doi sang cot khac: cot cu tro lai ▲▼
  dom.window.handleSort('username');
  assert.equal(icon.textContent, NONE);
  assert.equal(th.getAttribute('aria-sort'), 'none');

  dom.window.close();
});

test('tieu de static cua Vong doi don hang dung nut .sort-button, khong con .sort-ind nam sau duoi chu', () => {
  const html = loadHtml('shipment/lifecycle/index.html');
  const dom = new JSDOM(html);
  const headers = [...dom.window.document.querySelectorAll('th.sortable')];

  assert.ok(headers.length >= 17, 'bang chinh + bang lich su');
  for (const th of headers) {
    assert.equal(th.getAttribute('aria-sort'), 'none', th.dataset.sort);
    assert.ok(th.querySelector(':scope > button.sort-button > .sort-label'), th.dataset.sort + ': nhan trong .sort-label');
    assert.equal(th.querySelector(':scope > button.sort-button > .sort-indicator').textContent, NONE);
  }
  assert.doesNotMatch(html, /sort-ind\b|sort-icon/);
  dom.window.close();
});

test('moi trang bang chi dung quy uoc sort o shared.css: khong tu dinh nghia lai nut/bieu tuong sap xep', () => {
  const pages = [
    'index.html', 'account/index.html', 'humanresources/index.html', 'shipment/lifecycle/index.html',
    'cashbook/index.html', 'vt-positions/index.html', 'vt-positions/vt-base.css', 'vt-positions/vt-positions.css','marketing-report.css'
  ];
  for (const page of pages) {
    const source = loadHtml(page);
    // bo chu thich de chi bat quy tac CSS/ma that
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    // Quy tac goc (bat dau bang .sort-button/.sort-indicator/.sort-label) chi o shared.css; trang chi duoc them
    // quy tac theo ngu canh (vd ".cb-table th.money .sort-button { text-align:right }").
    assert.doesNotMatch(code, /^\s*\.(sort-button|sort-indicator|sort-label)\b[^{}]*\{/m, page + ': .sort-button/.sort-indicator chi duoc dinh nghia o shared/shared.css');
    assert.doesNotMatch(code, /\.(cb-sort|cb-sort-mark|locations-sort-button|locations-sort-icon|sort-ind|sort-icon)\b/, page + ': con lop sort rieng cua trang');
    assert.doesNotMatch(code, /↕|['"]↑['"]|['"]↓['"]/, page + ': con bieu tuong sort cu');
  }
});

test('shared.css: bieu tuong sort la cot flex rieng, do rong co dinh, dinh mep phai o tieu de', () => {
  const css = loadHtml('shared/shared.css').replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = selector => {
    const match = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(match, selector + ' phai co trong shared.css');
    return match[1];
  };
  const button = rule('.sort-button');
  assert.match(button, /display:\s*flex/);
  assert.match(button, /text-align:\s*left/);
  assert.doesNotMatch(button, /justify-content:\s*center|text-align:\s*center/);
  assert.match(rule('.sort-indicator'), /flex:\s*none/, 'bieu tuong khong co/gian theo nhan');
  assert.match(rule('.sort-indicator'), /width:\s*\d+px/, 'do rong co dinh de doi trang thai khong lam nhan nhay dong');
  assert.match(rule('.sort-button > .sort-label,\n.sort-button > span:first-child'), /flex:\s*1 1 auto/, 'nhan chiem phan con lai va tu xuong dong');
  assert.match(rule('table thead th,\ntable thead th .sort-button,\ntable thead th button[data-col]'), /text-align:\s*center\s*!important/);
  assert.match(rule('table td.col-num'), /text-align:\s*right/, 'numeric body alignment is preserved');
  assert.match(css, /th\[aria-sort="ascending"\] \.sort-indicator[\s\S]*?color:\s*var\(--amber\)/);
});
