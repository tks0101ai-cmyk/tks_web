'use strict';

// Doc NHANH du lieu don Kiot (bang da dong bo orders / order_details) CHO NHUNG DON DANG CO CHI DINH BOC HANG
// (vai chuc → vai tram don), khong doc lai 60 nghin don cua trang Vong doi. Khong goi API KiotViet.
//   - kiotOutcome: trang thai Kiot -> 'completed' (Hoan thanh) | 'cancelled' (Da huy) | null.
//   - readKiotStatuses: trang thai Kiot cua cac don (dung unique index orders (branch, code)).
//   - readKiotLineKeys: ma hang con tren don Kiot (bo dong chi dinh cua ma da xoa khoi don).
const { tx } = require('../stockPositions/stockPositionsService');

const { DB_BRANCH } = tx;

// KiotViet luu SĐT dang "+84923170904"; ban in muon dang noi dia "0923170904". Khong doan duoc thi giu nguyen.
function toLocalPhone(value) {
  const raw = String(value ?? '').trim();
  const match = /^(?:\+84|0084|84)0?(\d{9})$/.exec(raw.replace(/[\s.\-()]/g, ''));
  return match ? '0' + match[1] : raw;
}

// GET /users: mobilePhone belongs to sold_by_id in the same retailer. Never match by name.
function createSellerPhoneLookup({
  getBranches = () => require('../kiotvietSync/config').getConfiguredBranches({warn:()=>{}}),
  createClient = require('../kiotviet/kiotVietApiClient').createKiotVietClient,
  now = Date.now
} = {}) {
  const cache = new Map();
  return async (branch, sellerId) => {
    if (!sellerId) return '';
    const config = getBranches().find(item => item.branch === branch);
    if (!config) return '';
    const key = branch + ':' + (config.retailer || '');
    let entry = cache.get(key);
    if (!entry || entry.expires <= now()) {
      entry = {expires:Infinity};
      entry.pending = (async () => {
        try {
          const phones = new Map();
          const client = createClient({...config, requestOptions:{maxRetries:1,timeoutMs:5000}});
          await client.fetchAllPages('users', {}, async users => {
            for (const user of users) phones.set(String(user.id), toLocalPhone(user.mobilePhone));
          }, {requireComplete:true});
          entry.expires = now() + 300000;
          return phones;
        } catch (error) {
          entry.expires = now() + 30000;
          return new Map();
        }
      })();
      cache.set(key, entry);
    }
    return (await entry.pending).get(String(sellerId)) || '';
  };
}
const readSellerPhone = createSellerPhoneLookup();
async function loadSellerPhone(db, branch, orderCode) {
  try {
    const {rows} = await db.query('SELECT sold_by_id FROM orders WHERE branch=$1 AND code=$2', [DB_BRANCH[branch], orderCode]);
    return await readSellerPhone(DB_BRANCH[branch], rows[0]?.sold_by_id);
  } catch (error) { return ''; }
}

const codeKey = value => String(value ?? '').trim().toLowerCase();
const foldText = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase().replace(/\s+/gu, ' ').trim();

function kiotOutcome(statusText) {
  const status = foldText(statusText);
  if (status === 'hoan thanh') return 'completed';
  if (status === 'da huy') return 'cancelled';
  return null;
}

const uniqueCodes = codes => [...new Set((codes || []).map(code => String(code ?? '').trim()).filter(Boolean))];

// Map 'ma don chu thuong' -> trang thai Kiot (chuoi goc, '' neu thieu). Don khong co trong DB khong co khoa.
async function readKiotStatuses(db, branch, codes) {
  const found = new Map();
  const list = uniqueCodes(codes);
  if (!list.length) return found;
  const { rows } = await db.query(
    `SELECT o.code, COALESCE(o.raw->>'statusValue', '') AS status FROM orders o WHERE o.branch = $1 AND o.code = ANY($2::text[])`,
    [DB_BRANCH[branch], list]);
  for (const row of rows) found.set(codeKey(row.code), row.status);
  return found;
}

// Map 'ma don chu thuong' -> Set('ma hang chu thuong') cac ma hang (khong VAT*) con tren don Kiot, de bo dong chi dinh cua ma
// da xoa khoi don. Don co dong khong xac dinh duoc ma (thieu productCode va khong khop products) -> null: khong ket luan duoc.
// Don khong co dong nao trong DB (chua dong bo chi tiet) khong co khoa.
async function readKiotLineKeys(db, branch, codes) {
  const found = new Map();
  const list = uniqueCodes(codes);
  if (!list.length) return found;
  const { rows } = await db.query(
    `SELECT o.code, lower(btrim(COALESCE(NULLIF(d.raw->>'productCode', ''), p.code, ''))) AS product_key
       FROM orders o
       JOIN order_details d ON d.branch = o.branch AND d.order_id = o.id
       LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
      WHERE o.branch = $1 AND o.code = ANY($2::text[])`,
    [DB_BRANCH[branch], list]);
  for (const row of rows) {
    const orderKey = codeKey(row.code);
    if (!found.has(orderKey)) found.set(orderKey, new Set());
    const keys = found.get(orderKey);
    if (!keys) continue;
    if (!row.product_key) found.set(orderKey, null);
    else if (!row.product_key.startsWith('vat')) keys.add(row.product_key);
  }
  return found;
}


module.exports = { toLocalPhone, kiotOutcome, readKiotStatuses, readKiotLineKeys, codeKey, createSellerPhoneLookup, readSellerPhone, loadSellerPhone };
