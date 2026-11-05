'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trailingThrottle, sortLines, waitForConfirm, EDIT_COLUMNS, parseClipboard, planPaste, planPasteByCode, planFill, moveIndex, matchesFilter, summarizeCells } = require('../public/stocktake/stocktakeGrid');
const { PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

test('EDIT_COLUMNS: 9 cot, deu la cot dan hop le', () => {
  assert.equal(Object.keys(EDIT_COLUMNS).length, 9);
  for (const column of Object.values(EDIT_COLUMNS)) assert.ok(PASTE_COLUMNS[column], column);
});

test('parseClipboard: tab / xuong dong, CRLF, dong trong cuoi, o boc ngoac kep', () => {
  assert.deepEqual(parseClipboard('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseClipboard('mot'), [['mot']]);
  assert.deepEqual(parseClipboard(''), []);
  assert.deepEqual(parseClipboard('"dong 1\ndong 2"\tx\n"co ""ngoac"""\ty'), [['dong 1 dong 2', 'x'], ['co "ngoac"', 'y']]);
  assert.deepEqual(parseClipboard('a\t\tc'), [['a', '', 'c']]);
});

test('planPaste: khoi tu o tren-trai, bo cot an, bo dong vuot cuoi', () => {
  const rect = { top: 3, bottom: 3, left: 6, right: 6 };
  const targets = planPaste([['x', 'y', 'z'], ['p', 'q', 'r']], rect, { rowCount: 5, visibleCols: [0, 1, 6, 8, 9] });
  assert.deepEqual(targets, [
    { row: 3, col: 6, raw: 'x' }, { row: 3, col: 8, raw: 'y' }, { row: 3, col: 9, raw: 'z' },
    { row: 4, col: 6, raw: 'p' }, { row: 4, col: 8, raw: 'q' }, { row: 4, col: 9, raw: 'r' }
  ]);
  assert.deepEqual(planPaste([['a'], ['b'], ['c']], { top: 4, bottom: 4, left: 6, right: 6 }, { rowCount: 5, visibleCols: [6] }), [{ row: 4, col: 6, raw: 'a' }]);
  assert.deepEqual(planPaste([['a', 'b']], { top: 0, bottom: 0, left: 9, right: 9 }, { rowCount: 5, visibleCols: [6, 9] }), [{ row: 0, col: 9, raw: 'a' }]);
  assert.deepEqual(planPaste([], rect, { rowCount: 5, visibleCols: [6] }), []);
});

test('planPaste: 1 o vao vung nhieu o thi dien ca vung (bo cot an)', () => {
  const targets = planPaste([['ok']], { top: 1, bottom: 2, left: 6, right: 8 }, { rowCount: 10, visibleCols: [6, 8] });
  assert.deepEqual(targets, [{ row: 1, col: 6, raw: 'ok' }, { row: 1, col: 8, raw: 'ok' }, { row: 2, col: 6, raw: 'ok' }, { row: 2, col: 8, raw: 'ok' }]);
});

test('planFill: keo xuong / len lap mau theo vong, giu cot', () => {
  const rect = { top: 2, bottom: 3, left: 6, right: 6 };
  assert.deepEqual(planFill(rect, 6, [6]), [
    { row: 4, col: 6, fromRow: 2 }, { row: 5, col: 6, fromRow: 3 }, { row: 6, col: 6, fromRow: 2 }
  ]);
  assert.deepEqual(planFill(rect, 0, [6]), [{ row: 1, col: 6, fromRow: 3 }, { row: 0, col: 6, fromRow: 2 }]);
  assert.deepEqual(planFill(rect, 3, [6]), []);
  assert.deepEqual(planFill({ top: 0, bottom: 0, left: 6, right: 8 }, 1, [6, 8]), [{ row: 1, col: 6, fromRow: 0 }, { row: 1, col: 8, fromRow: 0 }]);
});

test('moveIndex: di trong cot dang hien, kep hai dau', () => {
  assert.equal(moveIndex([0, 1, 6, 8], 1, 1), 6);
  assert.equal(moveIndex([0, 1, 6, 8], 8, 1), 8);
  assert.equal(moveIndex([0, 1, 6, 8], 0, -1), 0);
  assert.equal(moveIndex([0, 1, 6, 8], 7, 1), 8, 'cot hien tai bi an: lay cot hien gan nhat ben phai');
  assert.equal(moveIndex([0, 1, 6, 8], 7, -1), 6);
});

test('matchesFilter: 5 bo loc; note null / chi khoang trang = trong; gia tri la = tat ca', () => {
  const row = (statusText, printPage, forgotten = false) => ({ forgotten, note: statusText === null ? null : { statusText, printPage } });
  const rows = { both: row('mất', '12'), status: row('mất', ''), print: row('  ', '12'), none: row('', ''), noNote: row(null), forgot: row(null, null, true) };
  const pick = filter => Object.keys(rows).filter(key => matchesFilter(rows[key], filter));
  assert.deepEqual(pick('all'), ['both', 'status', 'print', 'none', 'noNote', 'forgot']);
  assert.deepEqual(pick('forgotten'), ['forgot']);
  assert.deepEqual(pick('statusOnly'), ['status']);
  assert.deepEqual(pick('printOnly'), ['print']);
  assert.deepEqual(pick('neither'), ['none', 'noNote', 'forgot']);
  assert.deepEqual(pick('noted'), pick('all'), 'gia tri cu / la = tat ca');
  assert.equal(matchesFilter({ forgotten: false, note: { statusText: 'x', printPage: null } }, 'statusOnly'), true);
});

test('summarizeCells: Dem o co gia tri, Tong / TB chi tinh o so (kieu thanh trang thai Excel)', () => {
  const total = summarizeCells([
    { text: '-1,200', number: -1200 },
    { text: '0', number: 0 },
    { text: '', number: null },
    { text: 'Mất', number: null },
    { text: '1.5', number: 1.5 }
  ]);
  assert.deepEqual(total, { count: 4, numeric: 3, sum: -1198.5, average: -399.5 });
  assert.deepEqual(summarizeCells([{ text: 'OK', number: null }, { text: '', number: null }]), { count: 1, numeric: 0, sum: 0, average: null });
  assert.equal(summarizeCells([{ text: 'x', number: NaN }]).numeric, 0, 'NaN khong tinh vao tong');
  assert.deepEqual(summarizeCells([]), { count: 0, numeric: 0, sum: 0, average: null });
});

test('planPasteByCode: cot dau la ma hang -> ghi theo ma, khong theo thu tu dong', () => {
  const codes = ['115CTCA', '20RDD', 'S100B250', 'kb8ibv'];
  const visibleCols = [0, 1, 5, 6, 7];
  // Tieu de + 3 ma theo thu tu khac bang, 1 ma khong co trong dot, 1 ma viet thuong/hoa khac, 1 dong trong.
  const block = [['Mã hàng', 'KK trước sai'], ['S100B250', '-5'], [' 20rdd ', '3'], ['XYZ', '9'], ['', ''], ['KB8IBV', '1']];
  const plan = planPasteByCode(block, { codes, visibleCols, startIndex: 2 });
  assert.equal(plan.header, true);
  assert.deepEqual(plan.targets, [
    { code: 'S100B250', col: 5, raw: '-5' },
    { code: '20RDD', col: 5, raw: '3' },
    { code: 'kb8ibv', col: 5, raw: '1' }
  ]);
  assert.deepEqual(plan.missing, ['XYZ']);
  assert.equal(plan.codes, 3);
  assert.equal(plan.duplicates, 0);
});

test('planPasteByCode: nhieu cot gia tri, cot vuot cuoi bo, ma lap lai lay dong duoi', () => {
  const plan = planPasteByCode([['A', 'x', 'y', 'z'], ['A', 'x2', 'y2', 'z2']], { codes: ['A'], visibleCols: [0, 3, 4], startIndex: 1 });
  assert.equal(plan.header, false);
  assert.equal(plan.duplicates, 1);
  assert.deepEqual(plan.targets, [{ code: 'A', col: 3, raw: 'x2' }, { code: 'A', col: 4, raw: 'y2' }]);
});

test('planPasteByCode: khong phai khoi theo ma -> null (dan theo vi tri nhu cu)', () => {
  const opts = { codes: ['A', 'B'], visibleCols: [0, 1, 2], startIndex: 1 };
  assert.equal(planPasteByCode([['-5'], ['3']], opts), null, '1 cot');
  assert.equal(planPasteByCode([['Mất', 'ly do'], ['OK', 'x']], opts), null, 'cot dau khong phai ma');
  assert.equal(planPasteByCode([['A', '1'], ['Q', '2'], ['R', '3']], opts), null, 'duoi nua la ma');
  assert.equal(planPasteByCode([], opts), null);
  assert.notEqual(planPasteByCode([['A', '1'], ['Q', '2']], opts), null, 'dung nua van tinh');
});

// Hop thoai gia: close() phat su kien 'close' giong <dialog>; Esc cung chi phat 'close'.
function confirmHarness() {
  const dialog = new EventTarget();
  dialog.close = () => dialog.dispatchEvent(new Event('close'));
  const ok = new EventTarget();
  const cancel = new EventTarget();
  const click = target => target.dispatchEvent(new Event('click'));
  return { dialog, ok, cancel, click };
}

test('waitForConfirm: Dong y = true, Huy = false', async () => {
  const { dialog, ok, cancel, click } = confirmHarness();
  const accepted = waitForConfirm(dialog, ok, cancel);
  click(ok);
  assert.equal(await accepted, true);
  const declined = waitForConfirm(dialog, ok, cancel);
  click(cancel);
  assert.equal(await declined, false);
});

test('waitForConfirm: Esc = khong dong y, lenh cu khong chay theo lan xac nhan sau', async () => {
  const { dialog, ok, cancel, click } = confirmHarness();
  const closeSession = waitForConfirm(dialog, ok, cancel);
  dialog.close(); // nguoi dung nhan Esc
  assert.equal(await closeSession, false);
  const importSheet = waitForConfirm(dialog, ok, cancel);
  let oldAnswer = 'chua tra loi lai';
  closeSession.then(value => { oldAnswer = value; });
  click(ok);
  assert.equal(await importSheet, true);
  assert.equal(oldAnswer, false);
});

test('waitForConfirm: moi lan chi tra loi 1 lan, khong con lang nghe sau khi xong', async () => {
  const { dialog, ok, cancel, click } = confirmHarness();
  const added = { dialog: 0, ok: 0, cancel: 0 };
  for (const [name, target] of Object.entries({ dialog, ok, cancel })) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (...args) => { added[name] += 1; add(...args); };
    target.removeEventListener = (...args) => { added[name] -= 1; remove(...args); };
  }
  const answer = waitForConfirm(dialog, ok, cancel);
  click(ok);
  click(cancel);
  assert.equal(await answer, true);
  assert.deepEqual(added, { dialog: 0, ok: 0, cancel: 0 });
});

test('sortLines: so tu nhien, tang giam, bo sort giu thu tu goc, o trong cuoi', () => {
  const a = { team: 'TEAM 10', zone: 'G2', quantity: 5, orderCode: 'DH2' };
  const b = { team: 'TEAM 2', zone: '', quantity: 50, orderCode: 'DH1' };
  const c = { team: 'TEAM 1', zone: 'G10', quantity: 7, manual: true, edit: { updatedByName: 'Hưng' } };
  const teams = list => list.map(line => line.team);
  assert.deepEqual(teams(sortLines([a, b, c], 'team', 'asc')), ['TEAM 1', 'TEAM 2', 'TEAM 10']);
  assert.deepEqual(teams(sortLines([a, b, c], 'team', 'desc')), ['TEAM 10', 'TEAM 2', 'TEAM 1']);
  assert.deepEqual(teams(sortLines([a, b, c], 'zone', 'asc')), ['TEAM 10', 'TEAM 1', 'TEAM 2']);
  assert.deepEqual(teams(sortLines([a, b, c], 'zone', 'desc')), ['TEAM 1', 'TEAM 10', 'TEAM 2']);
  assert.deepEqual(teams(sortLines([a, b, c], 'quantity', 'desc')), ['TEAM 2', 'TEAM 1', 'TEAM 10']);
  assert.deepEqual(teams(sortLines([a, b, c], 'order', 'asc')), ['TEAM 2', 'TEAM 10', 'TEAM 1']);
  assert.deepEqual(teams(sortLines([a, b, c], 'updated', 'asc')), ['TEAM 1', 'TEAM 10', 'TEAM 2']);
  assert.deepEqual(teams(sortLines([a, b, c], 'team', null)), ['TEAM 10', 'TEAM 2', 'TEAM 1']);
  assert.deepEqual(teams([a, b, c]), ['TEAM 10', 'TEAM 2', 'TEAM 1'], 'khong doi mang goc');
});

test('trailingThrottle: goi lien tuc chi chay 1 lan moi khoang, co lan cuoi, huy duoc', () => {
  let clock = 0;
  let pending = null;
  let runs = 0;
  const gate = trailingThrottle(() => { runs += 1; }, 3000, {
    now: () => clock,
    setTimer: (fn, wait) => { pending = { fn, at: clock + wait }; return pending; },
    clearTimer: () => { pending = null; }
  });
  const advance = () => { clock = pending.at; const { fn } = pending; pending = null; fn(); };
  gate.trigger();
  assert.equal(pending.at, 400, 'lan dau chi cho ngan');
  gate.trigger();
  gate.trigger();
  advance();
  assert.equal(runs, 1);
  clock = 1000;
  gate.trigger();
  assert.equal(pending.at, 3400, 'chua du 3 giay tu lan chay truoc');
  gate.trigger();
  advance();
  assert.equal(runs, 2);
  gate.trigger();
  gate.cancel();
  assert.equal(pending, null);
  assert.equal(runs, 2);
});
