'use strict';

// Danh sach ngan hang VietQR (chi ngan hang ho tro chuyen khoan Napas, transferSupported = 1),
// chep tu https://api.vietqr.io/v2/banks ngay 13/11/2026. Khong goi API luc chay.
// Them / bot ngan hang = sua file nay qua PR.

const BANK_ROWS = [
  ['970415', 'ICB', 'VietinBank'],
  ['970436', 'VCB', 'Vietcombank'],
  ['970418', 'BIDV', 'BIDV'],
  ['970405', 'VBA', 'Agribank'],
  ['970448', 'OCB', 'OCB'],
  ['970422', 'MB', 'MBBank'],
  ['970407', 'TCB', 'Techcombank'],
  ['970416', 'ACB', 'ACB'],
  ['970432', 'VPB', 'VPBank'],
  ['970423', 'TPB', 'TPBank'],
  ['970403', 'STB', 'Sacombank'],
  ['970437', 'HDB', 'HDBank'],
  ['970454', 'VCCB', 'VietCapitalBank'],
  ['970429', 'SCB', 'SCB'],
  ['970441', 'VIB', 'VIB'],
  ['970443', 'SHB', 'SHB'],
  ['970431', 'EIB', 'Eximbank'],
  ['970426', 'MSB', 'MSB'],
  ['546034', 'CAKE', 'CAKE'],
  ['546035', 'Ubank', 'Ubank'],
  ['963388', 'TIMO', 'Timo'],
  ['970400', 'SGICB', 'SaigonBank'],
  ['970409', 'BAB', 'BacABank'],
  ['971133', 'PVDB', 'PVcomBank Pay'],
  ['971025', 'momo', 'MoMo'],
  ['970412', 'PVCB', 'PVcomBank'],
  ['970414', 'MBV', 'MBV'],
  ['970419', 'NCB', 'NCB'],
  ['970424', 'SHBVN', 'ShinhanBank'],
  ['970425', 'ABB', 'ABBANK'],
  ['970427', 'VAB', 'VietABank'],
  ['970428', 'NAB', 'NamABank'],
  ['970430', 'PGB', 'PGBank'],
  ['970433', 'VIETBANK', 'VietBank'],
  ['970438', 'BVB', 'BaoVietBank'],
  ['970440', 'SEAB', 'SeABank'],
  ['970446', 'COOPBANK', 'COOPBANK'],
  ['970449', 'LPB', 'LPBank'],
  ['970452', 'KLB', 'KienLongBank'],
  ['668888', 'KBank', 'KBank'],
  ['971101', 'ZALOPAY', 'ZaloPay'],
  ['971032', 'MVAS', 'MVAS'],
  ['970434', 'IVB', 'IndovinaBank'],
  ['422589', 'CIMB', 'CIMB'],
  ['970444', 'CBB', 'CBBank'],
  ['970457', 'WVN', 'Woori'],
  ['970462', 'KBHN', 'KookminHN'],
  ['970463', 'KBHCM', 'KookminHCM']
];

const VIETQR_BANKS = Object.freeze(BANK_ROWS.map(([bin, code, shortName]) => Object.freeze({ bin, code, shortName })));

/** Ngan hang khop ma viet tat (code), ten ngan (shortName) hoac BIN; khong phan biet hoa/thuong. */
function findBank(input) {
  const target = String(input ?? '').trim().toLowerCase();
  if (!target) return null;
  return VIETQR_BANKS.find(bank => [bank.bin, bank.code, bank.shortName].some(value => value.toLowerCase() === target)) || null;
}

module.exports = { VIETQR_BANKS, findBank };
