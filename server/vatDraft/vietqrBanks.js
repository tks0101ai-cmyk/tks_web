'use strict';

// Danh sach day du 76 ngan hang cua https://api.vietqr.io/v2/banks (chep ngay 13/11/2026). Khong goi API luc chay.
// Co transferSupported cua API chi noi APP ngan hang do co quet VietQR de TRA tien hay khong,
// khong lien quan viec tai khoan o ngan hang do NHAN tien -> khong dung de loc tai khoan nhan.
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
  ['970463', 'KBHCM', 'KookminHCM'],
  ['971005', 'VTLMONEY', 'ViettelMoney'],
  ['971011', 'VNPTMONEY', 'VNPTMoney'],
  ['970466', 'KEBHANAHCM', 'KEBHanaHCM'],
  ['970467', 'KEBHANAHN', 'KEBHANAHN'],
  ['977777', 'MAFC', 'MAFC'],
  ['999888', 'VBSP', 'VBSP'],
  ['963668', 'BNP HN', 'BNP HN'],
  ['555666', 'BIDC', 'BIDC'],
  ['963666', 'BNP HCM', 'BNP HCM'],
  ['963688', 'BOCHK', 'BOCHK'],
  ['970465', 'BSP', 'BSP'],
  ['168999', 'CUBHCM', 'CUBHCM'],
  ['963686', 'ESUN', 'ESUN'],
  ['963669', 'ICBC', 'ICBC'],
  ['963326', 'TNEX', 'TNEX'],
  ['458761', 'HSBC', 'HSBC'],
  ['970442', 'HLBVN', 'HongLeong'],
  ['970455', 'IBK - HN', 'IBKHN'],
  ['970456', 'IBK - HCM', 'IBKHCM'],
  ['970406', 'Vikki', 'Vikki'],
  ['801011', 'NHB HN', 'Nonghyup'],
  ['796500', 'DBS', 'DBSBank'],
  ['970439', 'PBVN', 'PublicBank'],
  ['970410', 'SCVN', 'StandardChartered'],
  ['533948', 'CITIBANK', 'Citibank'],
  ['970458', 'UOB', 'UnitedOverseas'],
  ['970408', 'GPB', 'GPBank'],
  ['970421', 'VRB', 'VRB']
];

const VIETQR_BANKS = Object.freeze(BANK_ROWS.map(([bin, code, shortName]) => Object.freeze({ bin, code, shortName })));

/** Ngan hang khop ma viet tat (code), ten ngan (shortName) hoac BIN; khong phan biet hoa/thuong. */
function findBank(input) {
  const target = String(input ?? '').trim().toLowerCase();
  if (!target) return null;
  return VIETQR_BANKS.find(bank => [bank.bin, bank.code, bank.shortName].some(value => value.toLowerCase() === target)) || null;
}

module.exports = { VIETQR_BANKS, findBank };
