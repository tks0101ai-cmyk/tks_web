'use strict';

// Cot O "Tồn VAT" cua Yeu cau xuat VAT: cot TỒN ĐẦU NGÀY cua tab Gộp VAT (file VAT TKS, cung
// tab Nhap VAT va Tra cuu VAT dung; truoc 23/10/2026 doc tab GỘP MỚI).
// Tra ma SP -> sheet "Khớp mã" -> MÃ VAT KIOT -> cong moi cong ty (cot CTY) cung ma VAT.
// Doc bang service account (Sheets API, chi doc) giong Nhap VAT (vatDraft/sheetsSource.js),
// cache 10 phut, loi tam thoi tra ban cu toi da 6 gio. Chi DOC sheet; khong dung thuat
// toan phan bo cua Nhap VAT.
//
// Mac dinh doc tab Gộp VAT va Khớp mã cua file trung gian "cúc cu test" (vatDraftConfig,
// IMPORTRANGE tu VAT TKS); van co the
// doi nguon qua bien moi truong (config.js): *_SHEET_ID = ID file, *_GID = sheetId cua tab.
// Doc theo chu cai cot nen doc ca tab. Bo cuc: A=CTY, B=Mã kiot đại diện, C=Tên kiot đại diện,
// D=MÃ VAT KIOT, E=TÊN VAT KIOT, I=TỒN ĐẦU NGÀY.
//
// Tu 26/10/2026 snapshot con giu danh muc ma tu 2 tab (productByCode) de ORDER VAT nhan ca ma
// co trong sheet ma chua co trong product_report (ma chi co o KiotViet SG, ngung kinh doanh,
// hoac ma VAT / ma dai dien khong phai ma hang KiotViet).

const { fetchSheetRecordsWithFallback, fallbackSourceFor, columnLetterToIndex } = require('../vatDraft/sheetsSource');
const { normalizeCode, normalizeCodeForMatch, toFloatOrNone } = require('../vatDraft/normalization');
const { createTtlSnapshotCache } = require('../lib/ttlSnapshotCache');
const vatDraftConfig = require('../vatDraft/vatDraftConfig');
const appConfig = require('../config');

function defaultStockConfig() {
  return {
    stockSheet: {
      spreadsheetId: appConfig.VAT_REQUEST_STOCK_SHEET_ID || vatDraftConfig.spreadsheetId,
      sheetId: appConfig.VAT_REQUEST_STOCK_GID || vatDraftConfig.gopVatSheet.sheetId
    },
    stockSkipRows: 1,
    stockColumns: { company: 'A', representativeCode: 'B', representativeName: 'C', vatCode: 'D', vatName: 'E', stock: appConfig.VAT_REQUEST_STOCK_COLUMN || 'I' },
    mappingSheet: {
      spreadsheetId: appConfig.VAT_REQUEST_MAPPING_SHEET_ID || vatDraftConfig.spreadsheetId,
      sheetId: appConfig.VAT_REQUEST_MAPPING_GID || vatDraftConfig.khopMaSheet.sheetId
    },
    // Tab trung gian hong (#REF! ...) thi doc tab tuong ung cua file goc VAT TKS (cung bo cuc cot).
    stockFallbackSheet: fallbackSourceFor(vatDraftConfig, 'gopVatSheet'),
    mappingFallbackSheet: fallbackSourceFor(vatDraftConfig, 'khopMaSheet'),
    mappingSkipRows: vatDraftConfig.khopMaSkipRows,
    mappingColumns: {
      productCode: vatDraftConfig.khopMaColumns['Mã SP'],
      productName: vatDraftConfig.khopMaColumns['Tên SP'],
      vatCode: vatDraftConfig.khopMaColumns['Mã vat kiot']
    }
  };
}

function cellReader(columns) {
  const indexes = Object.fromEntries(Object.entries(columns).map(([name, letter]) => [name, columnLetterToIndex(letter)]));
  return (row, name) => (name in indexes ? normalizeCode(row[indexes[name]] ?? '') : '');
}

/** Ghi ma vao danh muc neu chua co (dong / nguon dau tien thang); ten rong thi lay ten cua lan gap sau. */
function addCatalogEntry(catalog, code, name) {
  const key = normalizeCodeForMatch(code);
  if (!key) return;
  const entry = catalog.get(key);
  if (!entry) catalog.set(key, { code, name });
  else if (!entry.name && name) entry.name = name;
}

/**
 * Tab ton (mang dong) -> Map(maVatNorm -> [{ company, stock }]) + Map(maKiotDaiDienNorm -> Set(maVatNorm))
 * + danh muc ma (cot B va D kem ten cot C / E).
 */
function parseStockRecords(records, config) {
  const read = cellReader(config.stockColumns);
  const stockByVat = new Map();
  const vatByRepresentative = new Map();
  const representativeCatalog = new Map();
  const vatCatalog = new Map();
  for (const row of records.slice(config.stockSkipRows)) {
    const vatKey = normalizeCodeForMatch(read(row, 'vatCode'));
    if (!vatKey) continue;
    const stock = toFloatOrNone(read(row, 'stock'));
    if (!stockByVat.has(vatKey)) stockByVat.set(vatKey, []);
    stockByVat.get(vatKey).push({ company: read(row, 'company'), vatCode: read(row, 'vatCode'), stock: stock === null ? 0 : stock });
    addCatalogEntry(vatCatalog, read(row, 'vatCode'), read(row, 'vatName'));
    addCatalogEntry(representativeCatalog, read(row, 'representativeCode'), read(row, 'representativeName'));
    const repKey = normalizeCodeForMatch(read(row, 'representativeCode'));
    if (repKey) {
      if (!vatByRepresentative.has(repKey)) vatByRepresentative.set(repKey, new Set());
      vatByRepresentative.get(repKey).add(vatKey);
    }
  }
  return { stockByVat, vatByRepresentative, representativeCatalog, vatCatalog };
}

/**
 * Tab Khớp mã (mang dong) -> Map(maSpNorm -> Set(maVatNorm)); kem danh muc Mã SP / Tên SP qua tham so
 * catalog (ca dong chua co Mã vat kiot).
 */
function parseMappingRecords(records, config, catalog = new Map()) {
  const read = cellReader(config.mappingColumns);
  const vatByProduct = new Map();
  for (const row of records.slice(config.mappingSkipRows)) {
    addCatalogEntry(catalog, read(row, 'productCode'), read(row, 'productName'));
    const productKey = normalizeCodeForMatch(read(row, 'productCode'));
    const vatKey = normalizeCodeForMatch(read(row, 'vatCode'));
    if (!productKey || !vatKey) continue;
    if (!vatByProduct.has(productKey)) vatByProduct.set(productKey, new Set());
    vatByProduct.get(productKey).add(vatKey);
  }
  return vatByProduct;
}

/** Danh muc ma cua 2 tab, thu tu uu tien: Khớp mã (Mã SP) -> Gộp VAT cot B -> Gộp VAT cot D. */
function buildProductCatalog(mappingCatalog, representativeCatalog, vatCatalog) {
  const catalog = new Map();
  for (const source of [mappingCatalog, representativeCatalog, vatCatalog]) {
    for (const [key, entry] of source) {
      if (!catalog.has(key)) catalog.set(key, { ...entry });
      else if (!catalog.get(key).name && entry.name) catalog.get(key).name = entry.name;
    }
  }
  return catalog;
}

/** Ma SP co trong sheet (Khớp mã / Gộp VAT) -> { code, name } (code giu nguyen chu hoa / thuong cua sheet) hoac null. */
function findSheetProduct(snapshot, productCode) {
  const key = normalizeCodeForMatch(productCode);
  if (!key || !snapshot || !snapshot.productByCode) return null;
  return snapshot.productByCode.get(key) || null;
}

/** Goi y ma tu sheet: khop mot phan ma hoac ten (khong phan biet hoa thuong), uu tien khop dau ma. */
function suggestSheetProducts(snapshot, query, limit) {
  const q = normalizeCodeForMatch(query);
  if (!q || !snapshot || !snapshot.productByCode) return [];
  const matches = [];
  for (const [key, entry] of snapshot.productByCode) {
    if (key.includes(q) || normalizeCodeForMatch(entry.name).includes(q)) matches.push({ key, entry });
  }
  const rank = ({ key }) => (key === q ? 0 : key.startsWith(q) ? 1 : 2);
  matches.sort((a, b) => rank(a) - rank(b) || a.key.length - b.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return matches.slice(0, limit).map(({ entry }) => entry);
}

/**
 * Ton VAT cua 1 ma SP: { total, byCompany: [{ company, vatCode, stock }] } hoac null khi ma
 * chua khop ma VAT nao. Uu tien sheet Khớp mã; khong co thi dung cot Mã kiot đại diện; ma
 * nhap chinh la MÃ VAT KIOT thi lay thang dong ton cua ma VAT do.
 */
function lookupStock(snapshot, productCode) {
  const key = normalizeCodeForMatch(productCode);
  if (!key || !snapshot) return null;
  const vatKeys = snapshot.vatByProduct.get(key) || snapshot.vatByRepresentative.get(key)
    || (snapshot.stockByVat.has(key) ? new Set([key]) : null);
  if (!vatKeys || !vatKeys.size) return null;
  const byCompany = [];
  for (const vatKey of vatKeys) byCompany.push(...(snapshot.stockByVat.get(vatKey) || []));
  if (!byCompany.length) return null;
  const total = byCompany.reduce((sum, entry) => sum + entry.stock, 0);
  return { total, byCompany };
}

function createStockSource({ readValues, config = defaultStockConfig(), now, logger } = {}) {
  const cache = createTtlSnapshotCache({
    freshTtlMs: 10 * 60 * 1000,
    staleTtlMs: 6 * 60 * 60 * 1000,
    // Het 10 phut: tra ngay ban dang co va doc lai NGAM (nguoi dung khong cho Google Sheets; file goc VAT TKS
    // co luc mat 1-2 phut). Chi lan dau sau khi khoi dong (chua co ban nao) moi phai cho.
    backgroundRefresh: true,
    ...(now ? { now } : {}),
    fetch: async () => {
      const read = (source, fallbackSource, sheetName) => fetchSheetRecordsWithFallback({
        source, fallbackSource: fallbackSource || null, sheetName, readValues, ...(logger !== undefined ? { logger } : {})
      }).then(result => result.records);
      const [stockRecords, mappingRecords] = await Promise.all([
        read(config.stockSheet, config.stockFallbackSheet, 'Tồn VAT'),
        read(config.mappingSheet, config.mappingFallbackSheet, 'Khớp mã')
      ]);
      const { representativeCatalog, vatCatalog, ...stock } = parseStockRecords(stockRecords, config);
      const mappingCatalog = new Map();
      const vatByProduct = parseMappingRecords(mappingRecords, config, mappingCatalog);
      return { ...stock, vatByProduct, productByCode: buildProductCatalog(mappingCatalog, representativeCatalog, vatCatalog) };
    }
  });
  return {
    get: options => cache.get(options),
    set: data => cache.set(data),
    clear: () => cache.clear()
  };
}

module.exports = {
  defaultStockConfig, parseStockRecords, parseMappingRecords, buildProductCatalog,
  lookupStock, findSheetProduct, suggestSheetProducts, createStockSource
};
