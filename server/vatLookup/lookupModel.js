'use strict';

// Tra cuu VAT (port app Apps Script "Tra cứu VAT" logic v12, D:\tra-cuu\tra-cuu-vat).
// Logic THUAN, chep nguyen van tu Code.gs (do dong header) + Index.html (ghep san pham,
// tim kiem) de ket qua trung app cu: KHONG dung vatDraft/normalization (chuan hoa khac).
// Nguon: 3 tab file VAT TKS (Gộp VAT, Khớp mã, DK về 2 = MUA VAT SIDA A:E) — doc theo TEN cot nhu app cu.

const { pageRows, sortRows } = require('../shared/tablePage');

/* ---------- Code.gs: nhan dien dong header, ten cot duy nhat ---------- */

// headerAnchors: cac ten cot (da chuan hoa) phai co mat cung luc tren dong header that.
const SHEET_TARGETS = Object.freeze([
  Object.freeze({ key: 'gop', label: 'Gộp VAT', headerAnchors: ['cty', 'ma vat kiot'] }),
  Object.freeze({ key: 'khop', label: 'Khớp mã', headerAnchors: ['ma sp', 'ten sp'] }),
  Object.freeze({ key: 'dkve', label: 'DK về 2', headerAnchors: ['trang thai', 'ma kiot'] })
]);

function stripDiacritics(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Bo dau, ha chu thuong, gop khoang trang (dung chung cho ten cot va tu khoa). */
function normalizeText(value) {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Ma Kiot / Ma VAT: nhu normalizeText roi bo moi ky tu khong phai chu/so. */
function normalizeCode(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

const isBlank = value => String(value === null || value === undefined ? '' : value).trim() === '';

/** Do dong header trong toi da 15 dong dau; khong do duoc thi dung dong dau. */
function findHeaderRowIndex(values, anchors) {
  const limit = Math.min(values.length, 15);
  for (let i = 0; i < limit; i++) {
    const cells = values[i].map(normalizeText);
    if (anchors.every(anchor => cells.includes(anchor))) return i;
  }
  return 0;
}

function makeUniqueHeaders(headerRow) {
  const used = {};
  return headerRow.map((value, index) => {
    const base = String(value || '').trim() || ('Cột ' + (index + 1));
    let header = base;
    let suffix = 2;
    while (used[header]) header = base + ' (' + suffix++ + ')';
    used[header] = true;
    return header;
  });
}

/** Mang dong (CSV da parse) -> mang object theo ten cot, giong getProductData() cua Code.gs. */
function rowsToObjects(values, anchors) {
  if (!values.length || values[0].every(isBlank)) return [];
  const headerRowIndex = findHeaderRowIndex(values, anchors);
  const headers = makeUniqueHeaders(values[headerRowIndex]);
  const out = [];
  values.slice(headerRowIndex + 1).forEach((row, index) => {
    if (row.every(isBlank)) return;
    const item = {};
    headers.forEach((header, columnIndex) => { item[header] = row[columnIndex] || ''; });
    item.__rowNumber = headerRowIndex + 2 + index;
    out.push(item);
  });
  return out;
}

/* ---------- Index.html: tien ich ---------- */

/** So luong tu Sheet: chap nhan phan cach hang nghin , hoac .; o trong / chu -> 0. */
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let c = String(v).trim().replace(/\s+/g, '').replace(/[^\d,.-]/g, '');
  if (!/\d/.test(c)) return 0;
  const dots = (c.match(/\./g) || []).length;
  const commas = (c.match(/,/g) || []).length;
  if (dots && commas) {
    const decimalSep = c.lastIndexOf(',') > c.lastIndexOf('.') ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? /\./g : /,/g;
    c = c.replace(thousandsSep, '').replace(decimalSep, '.');
  } else if (dots || commas) {
    const sep = dots ? '.' : ',';
    const escaped = sep === '.' ? '\\.' : ',';
    const thousands = new RegExp(`^-?\\d{1,3}(?:${escaped}\\d{3})+$`);
    c = thousands.test(c) ? c.split(sep).join('') : c.replace(sep, '.');
  }
  const n = Number(c);
  return Number.isFinite(n) ? n : 0;
}

function buildHeaderResolver(sampleRow) {
  const keys = Object.keys(sampleRow || {}).filter(k => k !== '__sheetName' && k !== '__rowNumber');
  const map = new Map();
  keys.forEach(k => { const norm = normalizeText(k); if (!map.has(norm)) map.set(norm, k); });
  return aliases => { for (const a of aliases) if (map.has(a)) return map.get(a); return null; };
}
const cell = (row, key) => (key ? String(row[key] ?? '').trim() : '');

/* ---------- Index.html: ghep du lieu ---------- */

/** Khop ma: moi dong la mot cap (Ma Kiot -> Ma VAT Kiot). */
function buildKhopMaRows(rawRows) {
  if (!rawRows.length) return [];
  const resolve = buildHeaderResolver(rawRows[0]);
  const kMaSP = resolve(['ma sp']), kTenSP = resolve(['ten sp']);
  // Tab Khớp mã goc dat ten cot K la "Tên trước (Giá đầu - Giá cuối) (VAT)"; ban IMPORTRANGE
  // cu (FILE SALE) dat la "TÊN VAT KIOT" — cung du lieu.
  const kMaVat = resolve(['ma vat kiot']), kTenVat = resolve(['ten vat kiot', 'ten truoc (gia dau - gia cuoi) (vat)']);
  const out = [];
  rawRows.forEach(row => {
    const maKiot = cell(row, kMaSP), tenKiot = cell(row, kTenSP);
    const maVat = cell(row, kMaVat), tenVat = cell(row, kTenVat);
    const maKiotNorm = normalizeCode(maKiot);
    if (!maKiotNorm) return;
    out.push({ maKiot, tenKiot, maVat, tenVat, maKiotNorm, maVatNorm: normalizeCode(maVat) });
  });
  return out;
}

/** Gop VAT: gom theo (ma Kiot dai dien + ma VAT + Ten hang + DVT + Ten VAT), cong ton qua cac CTY. */
function buildGopVatGroups(rawRows) {
  const byKey = new Map();
  if (!rawRows.length) return byKey;
  const resolve = buildHeaderResolver(rawRows[0]);
  const kCty = resolve(['cty']);
  const kMaKiot = resolve(['ma kiot dai dien']), kTenKiot = resolve(['ten kiot dai dien']);
  // File trung gian dat ten cot E la "TÊN VAT KIOT (giá chưa vat tham khảo)" — cung du lieu.
  const kMaVat = resolve(['ma vat kiot']), kTenVat = resolve(['ten vat kiot', 'ten vat kiot (gia chua vat tham khao)']);
  const kTenHang = resolve(['ten hang']), kDvt = resolve(['don vi tinh', 'dvt']);
  const kTonDau = resolve(['ton dau ngay']), kTonNhap = resolve(['ton co the nhap']);
  const kTongThueMat = resolve(['tong thue mat', 'tong thue mat (thue xuat)']);

  rawRows.forEach(row => {
    const maKiotDaiDien = cell(row, kMaKiot), maVat = cell(row, kMaVat);
    const maKiotNorm = normalizeCode(maKiotDaiDien), maVatNorm = normalizeCode(maVat);
    if (!maKiotNorm && !maVatNorm) return;

    const tenHang = cell(row, kTenHang), dvt = cell(row, kDvt);
    const tenVat = cell(row, kTenVat);
    const baseKey = maKiotNorm + '|' + maVatNorm;
    const key = baseKey + '|' + normalizeText(tenHang) + '|' + normalizeText(dvt) + '|' + normalizeText(tenVat);
    if (!byKey.has(key)) byKey.set(key, {
      maKiotDaiDien, maKiotDaiDienNorm: maKiotNorm,
      tenKiotDaiDien: cell(row, kTenKiot), maVat, maVatNorm, baseKey, tenVat,
      tenHang, dvt, tongThueMat: '', tonDauNgay: 0, tonCoTheNhap: 0, ctys: new Set()
    });
    const g = byKey.get(key);
    if (!g.tenHang && tenHang) g.tenHang = tenHang;
    if (!g.dvt && dvt) g.dvt = dvt;
    if (!g.tongThueMat) g.tongThueMat = cell(row, kTongThueMat); // % thue: lay gia tri dau tien, khong cong
    if (!g.tenKiotDaiDien) g.tenKiotDaiDien = cell(row, kTenKiot);
    g.tonDauNgay += parseNumber(row[kTonDau]);
    g.tonCoTheNhap += parseNumber(row[kTonNhap]);
    const cty = cell(row, kCty);
    if (cty) g.ctys.add(cty);
  });
  return byKey;
}

/** "1. Đang chờ khai" -> "Đang chờ khai"; khong co so thu tu thi tra nguyen van. */
function trangThaiLabel(raw) {
  const m = String(raw ?? '').trim().match(/^\d+\.?\s*(.+)$/);
  return m ? m[1].trim() : String(raw ?? '').trim();
}

/** "2. Đang về cảng" -> 2; "10. ..." -> 10 (khong nham voi 1). */
function parseTrangThaiSo(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}
/** Chi trang thai 1, 2, 3 la "Chuẩn bị về". */
const isChuanBiVe = so => so === 1 || so === 2 || so === 3;

/** DK ve 2: nhom theo ma Kiot; cot cuoi khong co ten header la cot so luong, cot co ten khac vao extra. */
function buildDkVeRows(rawRows) {
  const byMaKiot = new Map();
  if (!rawRows.length) return byMaKiot;
  const resolve = buildHeaderResolver(rawRows[0]);
  const kMaKiot = resolve(['ma kiot']), kTenKiot = resolve(['ten kiot']);
  const kTrangThai = resolve(['trang thai']), kCont = resolve(['cont']);
  const knownKeys = new Set(['__sheetName', '__rowNumber', kMaKiot, kTenKiot, kTrangThai, kCont].filter(Boolean));

  const allKeys = Object.keys(rawRows[0] || {}).filter(k => k !== '__sheetName' && k !== '__rowNumber');
  const lastUnnamedKey = [...allKeys].reverse().find(k => /^cột\s*\d+$/i.test(k.trim()));

  rawRows.forEach(row => {
    const maKiot = cell(row, kMaKiot), maKiotNorm = normalizeCode(maKiot);
    if (!maKiotNorm) return;
    const trangThaiRaw = cell(row, kTrangThai);
    const extra = {};
    Object.keys(row).forEach(k => {
      if (knownKeys.has(k)) return;
      if (k === lastUnnamedKey) return;
      if (/^cột\s*\d+$/i.test(k.trim())) return;
      const v = String(row[k] ?? '').trim();
      if (v) extra[k] = v;
    });
    const soLuongRaw = lastUnnamedKey ? String(row[lastUnnamedKey] ?? '').trim() : '';
    const entry = {
      maKiot, maKiotNorm, tenKiot: cell(row, kTenKiot),
      trangThaiRaw, trangThaiSo: parseTrangThaiSo(trangThaiRaw),
      cont: cell(row, kCont), soLuong: parseNumber(soLuongRaw), soLuongRaw, extra, rowNumber: row.__rowNumber
    };
    if (!byMaKiot.has(maKiotNorm)) byMaKiot.set(maKiotNorm, []);
    byMaKiot.get(maKiotNorm).push(entry);
  });
  return byMaKiot;
}

/**
 * Dong VAT lay tu 1 nhom Gop VAT: 4 cot Ma Kiot / Ten Kiot / Ma VAT Kiot / Ten VAT Kiot hien
 * dung cot B-E cua Gop VAT (10/11/2026), khong lay ten tu Khop ma.
 */
function gopVatLine(gop, mapped) {
  return {
    maKiot: gop.maKiotDaiDien, tenKiot: gop.tenKiotDaiDien, maVat: gop.maVat, tenVat: gop.tenVat,
    tenHang: gop.tenHang, dvt: gop.dvt, tongThueMat: gop.tongThueMat,
    tonDauNgay: gop.tonDauNgay, tonCoTheNhap: gop.tonCoTheNhap, mapped
  };
}

/** Danh sach san pham thong nhat theo Ma Kiot (uu tien danh tinh tu Khop ma de tim kiem). */
function buildProducts(khopRows, gopByKey) {
  const products = new Map();
  const gopByBaseKey = new Map();
  gopByKey.forEach((gop, key) => {
    if (!gopByBaseKey.has(gop.baseKey)) gopByBaseKey.set(gop.baseKey, []);
    gopByBaseKey.get(gop.baseKey).push({ key, gop });
  });
  function ensure(maKiotNorm, maKiot, tenKiot) {
    if (!products.has(maKiotNorm)) products.set(maKiotNorm, {
      maKiot: maKiot || '', tenKiot: tenKiot || '', maKiotNorm,
      hasKhopMa: false, vatLines: [], vatKeysSeen: new Set()
    });
    const p = products.get(maKiotNorm);
    if (!p.maKiot && maKiot) p.maKiot = maKiot;
    if (!p.tenKiot && tenKiot) p.tenKiot = tenKiot;
    return p;
  }

  khopRows.forEach(row => {
    const p = ensure(row.maKiotNorm, row.maKiot, row.tenKiot);
    p.hasKhopMa = true;
    if (!row.maVatNorm) return;
    const baseKey = row.maKiotNorm + '|' + row.maVatNorm;
    const matches = gopByBaseKey.get(baseKey) || [];
    if (!matches.length) {
      const placeholderKey = baseKey + '|||';
      if (p.vatKeysSeen.has(placeholderKey)) return;
      p.vatKeysSeen.add(placeholderKey);
      p.vatLines.push({ maVat: row.maVat, tenVat: row.tenVat, tenHang: '', dvt: '', tongThueMat: '', tonDauNgay: 0, tonCoTheNhap: 0, mapped: true });
      return;
    }
    matches.forEach(({ key, gop }) => {
      if (p.vatKeysSeen.has(key)) return;
      p.vatKeysSeen.add(key);
      p.vatLines.push(gopVatLine(gop, true));
    });
  });

  gopByKey.forEach((gop, key) => {
    if (!gop.maKiotDaiDienNorm) return;
    const p = ensure(gop.maKiotDaiDienNorm, gop.maKiotDaiDien, gop.tenKiotDaiDien);
    if (p.vatKeysSeen.has(key)) return;
    p.vatKeysSeen.add(key);
    p.vatLines.push(gopVatLine(gop, false));
  });

  return [...products.values()];
}

/** Bo sung san pham chi co o DK ve 2 (khong co o Khop ma / Gop VAT) de van tim duoc (fix 2026-08-19). */
function addMissingDkVeProducts(products, dkVeByMaKiot) {
  const existing = new Set(products.map(p => p.maKiotNorm));
  dkVeByMaKiot.forEach((rows, maKiotNorm) => {
    if (existing.has(maKiotNorm) || !rows.length) return;
    const first = rows.find(r => r.tenKiot) || rows[0];
    products.push({
      maKiot: first.maKiot || '', tenKiot: first.tenKiot || '', maKiotNorm,
      hasKhopMa: false, vatLines: [], vatKeysSeen: new Set()
    });
    existing.add(maKiotNorm);
  });
  return products;
}

/* ---------- Index.html: trang thai + tim kiem ---------- */

/** SUMIF TON CO THE NHAP theo ma VAT tren toan sheet Gop VAT (ca dong khong co ma Kiot dai dien). */
function sumTonCoTheNhapByMaVat(gopByKey) {
  const totals = new Map();
  gopByKey.forEach(g => {
    if (g.maVatNorm) totals.set(g.maVatNorm, (totals.get(g.maVatNorm) || 0) + g.tonCoTheNhap);
  });
  return totals;
}

/** Con VAT khi tong TON CO THE NHAP cua moi san pham cung ma VAT > 0 (theo ma VAT cua tung dong, 27/10/2026). */
function isConVat(model, maVat) {
  const maVatNorm = normalizeCode(maVat);
  return !!maVatNorm && (model.tonCoTheNhapByMaVat.get(maVatNorm) || 0) > 0;
}

function getIncomingRows(model, product) {
  const rows = model.dkVeByMaKiot.get(product.maKiotNorm) || [];
  return rows.filter(r => isChuanBiVe(r.trangThaiSo));
}

function searchProducts(products, query, limit = 80) {
  const queryCode = normalizeCode(query);
  const queryText = normalizeText(query);
  if (!queryCode && !queryText) return [];
  const ranked = [];
  products.forEach((p, index) => {
    const code = p.maKiotNorm, name = normalizeText(p.tenKiot);
    let priority = 0, tie = index;
    if (queryCode && code === queryCode) { priority = 1; tie = code.length; }
    else if (queryText && name === queryText) { priority = 2; tie = name.length; }
    else if (queryCode && code.startsWith(queryCode)) { priority = 3; tie = code.length; }
    else if (queryText && name.startsWith(queryText)) { priority = 4; tie = name.length; }
    else if (queryCode && code.includes(queryCode)) { priority = 5; tie = code.indexOf(queryCode); }
    else if (queryText && name.includes(queryText)) { priority = 6; tie = name.indexOf(queryText); }
    if (priority) ranked.push({ product: p, priority, tie, index });
  });
  ranked.sort((a, b) => a.priority - b.priority || a.tie - b.tie || a.index - b.index);
  const direct = ranked.slice(0, limit).map(r => r.product);
  if (!direct.length) return [];

  // San pham khac dung chung ma VAT voi ket qua truc tiep cung hien (chi cac dong VAT chung).
  const directCodes = new Set(direct.map(p => p.maKiotNorm));
  const sharedVatCodes = new Set();
  direct.forEach(p => p.vatLines.forEach(line => {
    const maVatNorm = normalizeCode(line.maVat);
    if (maVatNorm) sharedVatCodes.add(maVatNorm);
  }));
  if (!sharedVatCodes.size || direct.length >= limit) return direct;

  const related = [];
  products.forEach(p => {
    if (directCodes.has(p.maKiotNorm) || direct.length + related.length >= limit) return;
    const sharedVatLines = p.vatLines.filter(line => sharedVatCodes.has(normalizeCode(line.maVat)));
    if (sharedVatLines.length) related.push(Object.assign({}, p, { vatLines: sharedVatLines }));
  });
  return direct.concat(related);
}

const MAX_SEARCH_TERMS = 100;
const MAX_TABLE_ROWS = 500;

/** Tach danh sach dan theo dong (va dau ;), bo trung, toi da 100 tu khoa. */
function parseSearchQueries(value) {
  const rawQueries = String(value ?? '').split(/\r?\n|;/).map(q => q.trim()).filter(Boolean);
  const queries = [];
  const seen = new Set();
  rawQueries.forEach(query => {
    const identity = normalizeText(query);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    queries.push(query);
  });
  return { queries: queries.slice(0, MAX_SEARCH_TERMS), ignoredCount: Math.max(0, queries.length - MAX_SEARCH_TERMS) };
}

/** Tim tung tu khoa roi hop nhat theo Ma Kiot (ban truc tiep uu tien hon ban gian tiep). */
function searchMultipleProducts(products, queries) {
  const canonicalByCode = new Map(products.map(product => [product.maKiotNorm, product]));
  const matchesByCode = new Map();
  const matchedQueries = [];
  const notFoundQueries = [];
  const lineIdentity = line => [normalizeCode(line.maVat), normalizeText(line.tenVat), normalizeText(line.tenHang), normalizeText(line.dvt)].join('|');

  const mergeRelatedProduct = (current, incoming) => {
    const vatLines = [...current.vatLines];
    const seenVatLines = new Set(vatLines.map(lineIdentity));
    incoming.vatLines.forEach(line => {
      const identity = lineIdentity(line);
      if (seenVatLines.has(identity)) return;
      seenVatLines.add(identity);
      vatLines.push(line);
    });
    return Object.assign({}, current, { vatLines });
  };

  queries.forEach(query => {
    const matches = searchProducts(products, query);
    if (!matches.length) {
      notFoundQueries.push(query);
      return;
    }
    matchedQueries.push(query);
    matches.forEach((product, index) => {
      const identity = product.maKiotNorm || normalizeCode(product.maKiot) || `${normalizeText(product.tenKiot)}:${index}`;
      const existing = matchesByCode.get(identity);
      const isDirect = canonicalByCode.get(identity) === product;
      if (!existing || (isDirect && !existing.isDirect)) {
        matchesByCode.set(identity, { product, isDirect });
      } else if (!existing.isDirect && !isDirect) {
        existing.product = mergeRelatedProduct(existing.product, product);
      }
    });
  });
  return { matches: [...matchesByCode.values()].map(entry => entry.product), matchedQueries, notFoundQueries };
}

/* ---------- Model + ket qua cho 2 tab ---------- */

/** rowsBySheet: { gop, khop, dkve } = mang object (rowsToObjects). */
function buildModel(rowsBySheet) {
  const gop = rowsBySheet.gop || [], khop = rowsBySheet.khop || [], dkve = rowsBySheet.dkve || [];
  const gopByKey = buildGopVatGroups(gop);
  const products = buildProducts(buildKhopMaRows(khop), gopByKey);
  const dkVeByMaKiot = buildDkVeRows(dkve);
  addMissingDkVeProducts(products, dkVeByMaKiot);
  return {
    products,
    dkVeByMaKiot,
    tonCoTheNhapByMaVat: sumTonCoTheNhapByMaVat(gopByKey),
    counts: { gop: gop.length, khop: khop.length, dkve: dkve.length },
    source: `Gộp VAT ${gop.length} dòng · Khớp mã ${khop.length} dòng · DK về 2 ${dkve.length} dòng`
  };
}

/** Tab "Hàng VAT có sẵn": moi dong VAT cua moi san pham khop (san pham khong co dong VAT -> 1 dong trong). */
function buildVatRows(model, products) {
  const rows = [];
  products.forEach(p => {
    const hasIncoming = getIncomingRows(model, p).length > 0;
    if (!p.vatLines.length) {
      rows.push({ maKiot: p.maKiot, tenKiot: p.tenKiot, maVat: '', tenVat: '', tenHang: '', dvt: '', tongThueMat: '', tonDauNgay: 0, tonCoTheNhap: 0, conVAT: false, hasIncoming });
      return;
    }
    // Dong co trong Gop VAT mang san Ma/Ten Kiot cua Gop VAT; dong chi co o Khop ma thi dung cua san pham.
    p.vatLines.forEach(l => rows.push({
      maKiot: l.maKiot ?? p.maKiot, tenKiot: l.tenKiot ?? p.tenKiot, maVat: l.maVat, tenVat: l.tenVat,
      tenHang: l.tenHang, dvt: l.dvt, tongThueMat: l.tongThueMat, tonDauNgay: l.tonDauNgay, tonCoTheNhap: l.tonCoTheNhap,
      conVAT: isConVat(model, l.maVat), hasIncoming
    }));
  });
  return rows;
}

/** Tab "Hàng sắp về": dong trang thai 1-3, gop theo (CONT + Ma Kiot) va cong so luong. */
function buildIncomingRows(model, products) {
  const merged = [];
  const seen = new Map();
  products.forEach(p => {
    getIncomingRows(model, p).forEach(r => {
      const key = (r.cont || '') + '|' + r.maKiotNorm;
      if (seen.has(key)) {
        const m = seen.get(key);
        m.soLuong += r.soLuong || 0;
        Object.entries(r.extra || {}).forEach(([k, v]) => { if (!m.extra[k]) m.extra[k] = v; });
      } else {
        const clone = Object.assign({}, r, { extra: Object.assign({}, r.extra) });
        seen.set(key, clone);
        merged.push(clone);
      }
    });
  });
  const extraKeys = [];
  const seenKeys = new Set();
  merged.forEach(r => Object.keys(r.extra || {}).forEach(k => { if (!seenKeys.has(k)) { seenKeys.add(k); extraKeys.push(k); } }));
  return {
    rows: merged.map(r => ({
      cont: r.cont, maKiot: r.maKiot, tenKiot: r.tenKiot, trangThaiSo: r.trangThaiSo,
      trangThai: trangThaiLabel(r.trangThaiRaw), soLuong: r.soLuong, hasSoLuong: !!r.soLuongRaw, extra: r.extra
    })),
    extraKeys
  };
}

/** Khi khong co dong sap ve: liet ke moi dong DK ve 2 cua cac ma da khop de thay ly do bi loai. */
function buildIncomingDebug(model, products) {
  const out = [];
  products.forEach(p => {
    (model.dkVeByMaKiot.get(p.maKiotNorm) || []).forEach(r => out.push({ maKiot: r.maKiot, trangThai: r.trangThaiRaw, rowNumber: r.rowNumber }));
  });
  return out;
}

/** Ket qua tra cuu cho ca 2 tab tu danh sach tu khoa (da qua parseSearchQueries). */
function search(model, queries, query = {}) {
  const modern = ['vatPage','vatPageSize','vatSorts','incomingPage','incomingPageSize','incomingSorts'].some(key => query[key] !== undefined);
  const catalog = keys => Object.fromEntries(keys.map(key => [key,row => row[key]]));
  function tablePage(rows, prefix, allowed) {
    if(!modern)return {total:rows.length,rows:rows.slice(0,MAX_TABLE_ROWS)};
    const sorted = sortRows(rows,query[prefix+'Sorts'],allowed);
    const requestedSize=Number(query[prefix+'PageSize']);
    return {total:rows.length,...pageRows(sorted,{page:query[prefix+'Page'],pageSize:Number.isSafeInteger(requestedSize) && requestedSize>0 ? Math.min(200,requestedSize) : 100})};
  }
  const result = searchMultipleProducts(model.products, queries);
  const vatRows = buildVatRows(model, result.matches);
  const incoming = buildIncomingRows(model, result.matches);
  return {
    productCount: result.matches.length,
    matchedQueries: result.matchedQueries,
    notFoundQueries: result.notFoundQueries,
    vat: tablePage(vatRows,'vat',{...catalog(['maKiot','tenKiot','maVat','tenVat','tenHang','dvt','tonDauNgay','tonCoTheNhap']),tongThueMat:row=>row.tongThueMat==null || row.tongThueMat==='' ? null : /\d/.test(row.tongThueMat)?parseNumber(row.tongThueMat):row.tongThueMat,trangThai:row=>row.conVAT?1:0}),
    incoming: {
      ...tablePage(incoming.rows,'incoming',{...catalog(['cont','maKiot','tenKiot']),trangThai:row=>row.trangThaiSo,soLuong:row=>row.hasSoLuong?row.soLuong:null,...Object.fromEntries(incoming.extraKeys.map((key,index)=>['extra'+index,row=>row.extra[key]]))}),
      extraKeys: incoming.extraKeys,
      debug: incoming.rows.length ? [] : buildIncomingDebug(model, result.matches)
    }
  };
}

module.exports = {
  SHEET_TARGETS,
  MAX_SEARCH_TERMS,
  MAX_TABLE_ROWS,
  normalizeText,
  normalizeCode,
  parseNumber,
  findHeaderRowIndex,
  makeUniqueHeaders,
  rowsToObjects,
  trangThaiLabel,
  parseTrangThaiSo,
  isChuanBiVe,
  buildModel,
  searchProducts,
  parseSearchQueries,
  searchMultipleProducts,
  search
};
