'use strict';

// Khoi "cap nhat gan thoi gian thuc" cua trang Bao cao tong hop chi phu thuoc
// EventSource/document/state/loadData nen trich RIENG doan ma that trong
// index.html ra chay trong vm - khong phai dung ca trang trong JSDOM.
//
// Truoc 2026-09-24 khoi nay dong EventSource VINH VIEN sau 5 loi lien tiep,
// nen khi stream chet (redeploy, mat mang, phien het han) trang treo o so lieu
// cu cho den khi nguoi dung tu F5 - dung trieu chung nguoi dung bao.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

function liveUpdateSource() {
  const match = html.match(/\(function setupDashboardLiveUpdates\(\) \{[\s\S]*?\n {4}\}\)\(\);/);
  assert.ok(match, 'phai tim thay khoi setupDashboardLiveUpdates trong index.html');
  return match[0];
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  fail() { if (this.onerror) this.onerror(); }
  emit(name) { if (this.listeners[name]) this.listeners[name](); }
}

function run({ lastFetchAt = Date.now(), permissionsDeferred = false, features = null } = {}) {
  FakeEventSource.instances = [];
  const loadCalls = [];
  const quietCalls = [];
  const timeouts = [];
  const documentHandlers = {};
  const state = { days: 30, lastFetchAt };

  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { documentHandlers[name] = fn; }
  };
  const context = {
    EventSource: FakeEventSource,
    state,
    loadData: (days, manual) => loadCalls.push({ days, manual }),
    refreshCustomerProductReportQuietly: () => quietCalls.push(true),
    document: fakeDocument,
    // Trang that cho authGuard() nap quyen roi moi ket noi SSE (afterPermissions) va chi mo khi co quyen /api/dashboard (hasFeature).
    // Khoi nay chay trong vm nen gia lap: quyen da biet (permissionsDeferred = false) -> ket noi ngay.
    permissionsDeferred,
    hasFeature: key => (features ? features.includes(key) : true),
    afterPermissions: callback => callback(),
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
    Date,
    Math
  };
  vm.createContext(context);
  new vm.Script(liveUpdateSource()).runInContext(context);

  return {
    loadCalls, quietCalls, timeouts, state, documentHandlers, document: fakeDocument,
    streams: FakeEventSource.instances,
    latestStream: () => FakeEventSource.instances[FakeEventSource.instances.length - 1]
  };
}

test('mo ket noi SSE ngay khi trang chay', () => {
  const app = run();
  assert.equal(app.streams.length, 1);
  assert.equal(app.streams[0].url, '/api/dashboard/events');
});

test('su kien dashboard-updated giai nhip bang setTimeout ngau nhien 0-3s roi moi keo lai du lieu o nen (khong bat man che)', () => {
  const app = run();
  app.latestStream().emit('dashboard-updated');

  // Chua goi loadData ngay - phai qua setTimeout truoc de rai request giua
  // nhieu tab, tranh don tai pool ket noi DB ngay sau luot rollup.
  assert.deepEqual(app.loadCalls, []);
  assert.equal(app.timeouts.length, 1, 'phai len lich dung 1 timeout moi (khong co retry/scheduleRetry nao khac trong kich ban nay)');
  const entry = app.timeouts[app.timeouts.length - 1];
  assert.ok(entry.ms >= 0 && entry.ms < 3000, 'do tre phai nam trong khoang [0, 3000)');

  entry.fn();
  assert.deepEqual(app.loadCalls, [{ days: 30, manual: false }]);
  // Bao cao doanh thu theo khach dang xem cung duoc tai lai ngam (khong dung vao man che/loadData).
  assert.equal(app.quietCalls.length, 1);
});

test('stream chet khong con lam trang treo vinh vien: co lich ket noi lai', () => {
  const app = run();
  const first = app.latestStream();
  first.open();

  for (let i = 0; i < 4; i++) first.fail();
  assert.equal(first.readyState, 1, 'vai loi le te thi de EventSource tu retry, chua can can thiep');
  assert.equal(app.timeouts.length, 0);

  first.fail(); // loi thu 5
  assert.equal(first.readyState, 2, 'phai ngung vong retry cua EventSource de khong spam request');
  assert.equal(app.timeouts.length, 1, 'nhung phai hen gio thu lai, khong duoc bo cuoc han');

  app.timeouts[0].fn();
  assert.equal(app.streams.length, 2, 'phai mo ket noi moi');
});

test('ket noi lai duoc thi keo lai du lieu da bo lo trong luc dut', () => {
  const app = run({ lastFetchAt: Date.now() - 10 * 60 * 1000 });
  app.latestStream().open();
  assert.deepEqual(app.loadCalls, [{ days: 30, manual: false }]);
});

test('ket noi lai khi du lieu con moi thi khong goi lai server', () => {
  const app = run({ lastFetchAt: Date.now() });
  app.latestStream().open();
  assert.equal(app.loadCalls.length, 0);
});

test('quay lai tab sau khi di lau: lam moi du lieu va noi lai stream da chet', () => {
  const app = run({ lastFetchAt: Date.now() - 10 * 60 * 1000 });
  const first = app.latestStream();
  for (let i = 0; i < 5; i++) first.fail();
  assert.equal(first.readyState, 2);

  app.documentHandlers.visibilitychange();
  assert.equal(app.loadCalls.length, 1, 'phai lam moi ngay khi nguoi dung quay lai');
  assert.equal(app.streams.length, 2, 'va noi lai stream thay vi doi het thoi gian hen');
});

test('tab vua bi an di thi khong keo du lieu hay mo them stream', () => {
  const app = run({ lastFetchAt: Date.now() - 10 * 60 * 1000 });
  app.document.visibilityState = 'hidden';

  app.documentHandlers.visibilitychange();

  assert.equal(app.loadCalls.length, 0);
  assert.equal(app.streams.length, 1);
});

// Bao cao tong hop tai THEO TUNG TAB (view): SSE chi tai lai tab dang xem, con cac tab da tai
// truoc do phai tu biet la cu de tai lai khi duoc mo (state.dataEpoch, xem ensureViewData).
test('su kien dashboard-updated danh dau moi tab da tai la cu ngay lap tuc (dataEpoch tang), roi moi tai lai tab dang xem', () => {
  const app = run();
  app.latestStream().emit('dashboard-updated');
  assert.equal(app.state.dataEpoch, 1, 'tab khac dang mo sau do phai thay du lieu cu ngay, khong cho het do tre 0-3s');
  assert.deepEqual(app.loadCalls, []);

  app.latestStream().emit('dashboard-updated');
  assert.equal(app.state.dataEpoch, 2);
});

test('quay lai tab/noi lai stream sau khi di lau: danh dau cac tab khac la cu; du lieu con moi thi khong dong den dataEpoch', () => {
  const stale = run({ lastFetchAt: Date.now() - 10 * 60 * 1000 });
  stale.latestStream().open();
  assert.equal(stale.state.dataEpoch, 1);
  assert.equal(stale.loadCalls.length, 1);

  const fresh = run({ lastFetchAt: Date.now() });
  fresh.latestStream().open();
  assert.equal(fresh.state.dataEpoch, undefined);
  assert.equal(fresh.loadCalls.length, 0);
});

test('tai khoan chi co Hang hoa / Du kien hang ve (khong co quyen /api/dashboard) khong mo ket noi SSE', () => {
  const app = run({ permissionsDeferred: true, features: ['reports.products.expected'] });
  assert.equal(app.streams.length, 0);
  // Quay lai tab cung khong tu mo stream.
  app.document.visibilityState = 'visible';
  app.documentHandlers.visibilitychange();
  assert.equal(app.streams.length, 0);
});

test('tai khoan co mot trong cac quyen /api/dashboard thi van ket noi SSE khi trang da nap quyen', () => {
  const app = run({ permissionsDeferred: true, features: ['reports.debt'] });
  assert.equal(app.streams.length, 1);
});

// 11/11/2026: mọi tab nền cùng tải lại mỗi lần có tín hiệu từng làm tới 56 request bảng thưởng/phạt chạy cùng lúc.
test('tab dang an nhan dashboard-updated: chi danh dau cu, khong goi may chu; quay lai tab thi tai lai 1 lan', () => {
  const app = run({ lastFetchAt: Date.now() });
  app.document.visibilityState = 'hidden';
  app.latestStream().emit('dashboard-updated');
  app.latestStream().emit('dashboard-updated');
  assert.equal(app.state.dataEpoch, 2, 'cac tab khac van biet du lieu da cu');
  assert.equal(app.timeouts.length, 0, 'tab an khong hen tai lai');
  assert.equal(app.loadCalls.length, 0);

  app.document.visibilityState = 'visible';
  app.documentHandlers.visibilitychange();
  assert.equal(app.loadCalls.length, 1, 'quay lai tab: tai lai du du lieu con moi theo lastFetchAt');
  assert.equal(app.quietCalls.length, 1);
  app.documentHandlers.visibilitychange();
  assert.equal(app.loadCalls.length, 1, 'chi tai lai 1 lan cho cac tin hieu da lo');
});
