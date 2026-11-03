/* Phan thuan (khong DOM) cua viec sua tren bang Kiem ke: cot sua duoc, tach du lieu dan, tinh o dan / o keo.
   Dung chung trinh duyet (window.TKSStocktakeGrid) va Node (test). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeGrid = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Khoa cot bang (COLUMNS.key) -> cot dan (PASTE_COLUMNS) ma /cells hieu.
  const EDIT_COLUMNS = Object.freeze({
    status: 'statusText', reason: 'reasonText', printPage: 'printPage', printTime: 'printTime', recheck: 'recheck',
    prevDiff: 'prevDiffManual', otherDiff: 'otherDiffManual', cluster: 'cluster', combo: 'combo'
  });

  // TSV tu Google Sheets: o co tab / xuong dong duoc boc "..." ("" = 1 dau ngoac kep). Xuong dong trong o -> dau cach.
  function parseClipboard(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(cells => cells.map(value => value.replace(/[\t\n]+/g, ' ')));
  }

  // Khoi dan -> o dich. 1 o + vung nhieu o = dien ca vung; con lai dat khoi tu o tren-trai, bo cot an, bo dong vuot cuoi.
  function planPaste(block, rect, { rowCount, visibleCols }) {
    if (!block.length) return [];
    const inRect = visibleCols.filter(col => col >= rect.left && col <= rect.right);
    if (!inRect.length) return [];
    const targets = [];
    if (block.length === 1 && block[0].length === 1 && (rect.bottom > rect.top || inRect.length > 1)) {
      for (let row = rect.top; row <= Math.min(rect.bottom, rowCount - 1); row++) {
        for (const col of inRect) targets.push({ row, col, raw: block[0][0] });
      }
      return targets;
    }
    const start = visibleCols.indexOf(inRect[0]);
    block.forEach((cells, i) => {
      const row = rect.top + i;
      if (row >= rowCount) return;
      cells.forEach((raw, j) => {
        const col = visibleCols[start + j];
        if (col !== undefined) targets.push({ row, col, raw });
      });
    });
    return targets;
  }

  // Keo nut goc tu vung rect toi dong `to`: moi dong moi lay dong nguon theo vong, dem tu mep vung chon ra ngoai.
  function planFill(rect, to, cols) {
    const height = rect.bottom - rect.top + 1;
    const pairs = [];
    if (to > rect.bottom) for (let row = rect.bottom + 1; row <= to; row++) pairs.push([row, rect.top + ((row - rect.bottom - 1) % height)]);
    else if (to < rect.top) for (let row = rect.top - 1; row >= to; row--) pairs.push([row, rect.bottom - ((rect.top - 1 - row) % height)]);
    const targets = [];
    for (const [row, fromRow] of pairs) {
      for (const col of cols) if (col >= rect.left && col <= rect.right) targets.push({ row, col, fromRow });
    }
    return targets;
  }

  // Cot ke ben trong danh sach cot dang hien (tang dan); cot hien tai bi an thi lay cot hien gan nhat theo huong di.
  function moveIndex(list, current, step) {
    if (!list.length) return current;
    let at = list.indexOf(current);
    if (at === -1) {
      const next = list.findIndex(col => col > current);
      if (step > 0) return next === -1 ? list[list.length - 1] : list[next];
      return next === -1 ? list[list.length - 1] : list[Math.max(0, next - 1)];
    }
    at = Math.max(0, Math.min(list.length - 1, at + step));
    return list[at];
  }

  // Bo loc chinh cua bang. Trang thai / Trang in "co chu" = khac rong sau khi bo khoang trang; mau va Gio in khong tinh.
  function matchesFilter(row, filter) {
    const note = row.note || {};
    const hasStatus = String(note.statusText ?? '').trim() !== '';
    const hasPrint = String(note.printPage ?? '').trim() !== '';
    switch (filter) {
      case 'forgotten': return Boolean(row.forgotten);
      case 'statusOnly': return hasStatus && !hasPrint;
      case 'printOnly': return hasPrint && !hasStatus;
      case 'neither': return !hasStatus && !hasPrint;
      default: return true;
    }
  }

  return { EDIT_COLUMNS, parseClipboard, planPaste, planFill, moveIndex, matchesFilter };
});
