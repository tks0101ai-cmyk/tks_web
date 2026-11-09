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

  // Thanh tong kieu Excel cho vung chon. cells: [{ text, number }].
  // Dem = o co gia tri (chu hoac so); Tong / TB chi tinh o co so (number la so huu han), bo o trong va o chu.
  function summarizeCells(cells) {
    let count = 0;
    let numeric = 0;
    let sum = 0;
    for (const cell of cells) {
      if (String(cell.text ?? '') !== '') count++;
      if (typeof cell.number === 'number' && Number.isFinite(cell.number)) { numeric++; sum += cell.number; }
    }
    return { count, numeric, sum, average: numeric ? sum / numeric : null };
  }

  // Dan theo ma hang: khoi tu Sheets co cot dau la Ma hang (tu 2 cot tro len). Nhan la khoi theo ma khi it nhat nua so
  // o cot dau (khong tinh dong tieu de) la ma co trong dot; dong dau khong phai ma = tieu de, bo qua.
  // Cot gia tri thu j (j >= 1) vao cot dang hien visibleCols[startIndex + j - 1]. Ma lap lai: dong duoi cung thang.
  // Khop ma: dung nguyen van (bo khoang trang dau/cuoi), khong thi khong phan biet hoa/thuong. Khong phai khoi theo ma -> null.
  function planPasteByCode(block, { codes, visibleCols, startIndex }) {
    if (!block.length || !block.some(cells => cells.length >= 2)) return null;
    const exact = new Set(codes);
    const loose = new Map();
    for (const code of codes) {
      const key = String(code).trim().toUpperCase();
      if (!loose.has(key)) loose.set(key, code);
    }
    const find = raw => {
      const text = String(raw ?? '').trim();
      if (!text) return null;
      if (exact.has(text)) return text;
      return loose.get(text.toUpperCase()) ?? null;
    };
    let rows = block;
    let header = false;
    if (rows.length > 1 && !find(rows[0][0])) { rows = rows.slice(1); header = true; }
    const filled = rows.filter(cells => String(cells[0] ?? '').trim() !== '');
    const matched = filled.filter(cells => find(cells[0])).length;
    if (!matched || matched * 2 < filled.length) return null;
    const byCell = new Map();
    const seen = new Set();
    const missing = [];
    let duplicates = 0;
    for (const cells of filled) {
      const code = find(cells[0]);
      if (!code) { missing.push(String(cells[0]).trim()); continue; }
      if (seen.has(code)) duplicates += 1;
      seen.add(code);
      for (let j = 1; j < cells.length; j++) {
        const col = visibleCols[startIndex + j - 1];
        if (col === undefined) break;
        byCell.set(code + '\u0000' + col, { code, col, raw: cells[j] });
      }
    }
    return { targets: [...byCell.values()], codes: seen.size, missing, duplicates, header };
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

  // Sort bang dong dem trong hop chi tiet. O trong luon nam cuoi; dir null = giu thu tu goc.
  const LINE_SORT = Object.freeze({
    team: line => line.team,
    zone: line => line.zone,
    spec: line => line.spec,
    quantity: line => line.quantity,
    order: line => (line.manual ? 'Thêm tay' : line.orderCode),
    updated: line => (line.edit ? line.edit.updatedByName : '')
  });
  function sortLines(lines, key, dir) {
    const sorts = (Array.isArray(key) ? key : dir ? [{ key, dir }] : []).filter(sort => LINE_SORT[sort.key]);
    const blank = value => value === null || value === undefined || value === '';
    return [...lines].sort((a, b) => {
      for (const sort of sorts) {
        const x = LINE_SORT[sort.key](a), y = LINE_SORT[sort.key](b);
        if (blank(x) || blank(y)) { if (blank(x) !== blank(y)) return blank(x) ? 1 : -1; continue; }
        const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi', { numeric: true });
        if (diff) return diff * (sort.dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  // Goi run nhieu nhat 1 lan moi gapMs, co lan cuoi de khong bo sot; goi lien tuc chi ton 1 lan chay.
  // run tra Promise (tai bang): cho luot dang chay xong moi hen luot sau, khong de cac luot cham chong len nhau.
  function trailingThrottle(run, gapMs, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, minDelayMs = 400 } = {}) {
    let last = -Infinity;
    let timer = null;
    let running = false;
    let again = false;
    function schedule() {
      timer = setTimer(fire, Math.max(minDelayMs, gapMs - (now() - last)));
    }
    async function fire() {
      timer = null;
      running = true;
      last = now();
      try { await run(); } catch (error) { /* run tu bao loi tren trang */ }
      running = false;
      if (again) { again = false; schedule(); }
    }
    return {
      trigger() {
        if (running) { again = true; return; }
        if (timer !== null) return;
        schedule();
      },
      cancel() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        again = false;
      }
    };
  }

  // Cho tra loi cua hop xac nhan. Moi cach dong (Dong y, Huy, Esc) deu phat su kien 'close' cua <dialog>, nen don
  // lang nghe tai day: neu Esc de lai lang nghe cu, lan Dong y cua hop sau se chay ca lenh truoc do (vd Dong dot).
  function waitForConfirm(dialog, okButton, cancelButton) {
    return new Promise(resolve => {
      let accepted = false;
      const finish = () => {
        okButton.removeEventListener('click', accept);
        cancelButton.removeEventListener('click', decline);
        dialog.removeEventListener('close', finish);
        resolve(accepted);
      };
      // Tra loi ngay khi bam nut: trinh duyet chi phat 'close' o khung hinh ke tiep, tab bi an thi cho rat lau.
      const accept = () => { accepted = true; finish(); dialog.close(); };
      const decline = () => { finish(); dialog.close(); };
      okButton.addEventListener('click', accept);
      cancelButton.addEventListener('click', decline);
      dialog.addEventListener('close', finish);
    });
  }

  // Khoang can cuon (px) khi keo chuot: pointer o trong [low + edge, high - edge] thi 0; di vao vung nguong thi tang dan,
  // ra ngoai khung thi dat tran `max`. Am = len / trai, duong = xuong / phai.
  function edgeScrollDelta(pointer, low, high, { edge = 40, max = 28 } = {}) {
    if (pointer < low + edge) return -Math.min(max, Math.ceil(((low + edge - pointer) / edge) * max));
    if (pointer > high - edge) return Math.min(max, Math.ceil(((pointer - (high - edge)) / edge) * max));
    return 0;
  }

  return { EDIT_COLUMNS, parseClipboard, planPaste, planPasteByCode, planFill, moveIndex, matchesFilter, summarizeCells, waitForConfirm, sortLines, trailingThrottle, edgeScrollDelta };
});
