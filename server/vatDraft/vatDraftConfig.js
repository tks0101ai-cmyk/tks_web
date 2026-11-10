'use strict';

// Cau hinh Nhap VAT — ban sao 1:1 config/settings.yaml cua vat-draft-app (16/10/2026).
// Doi tai khoan / cot sheet / trong so = sua file nay qua PR (giong sua settings.yaml truoc day).
// So tai khoan khong phai bi mat: in tren QR gui khach.

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

module.exports = deepFreeze({
  // File trung gian "cúc cu test" (khong cong khai) doc bang service account
  // GOOGLE_SERVICE_ACCOUNT_JSON, file phai chia se quyen Nguoi xem cho service account.
  // Moi tab chi la 1 IMPORTRANGE chep GIA TRI tu file "VAT TKS" (1f1vglJwsh...): Gộp VAT!A1:P,
  // Khớp mã!A1:K, MUA VAT SIDA (tab DK VỀ). Tu 10/11/2026 doc file nay thay vi doc thang VAT TKS:
  // VAT TKS co ~4 trieu o va hang tram nghin XLOOKUP/SUMIFS ca cot, Sheets API phai tinh lai ca
  // file nen values.get treo > 3 phut (ke ca doc 2 o), con file trung gian tra trong ~1-2 giay.
  // Tab xac dinh theo sheetId (= gid tren URL) nen doi ten tab khong anh huong.
  spreadsheetId: '1dNabQaiob7CMozrqjA746uV-atHWJi8gbG6L-I0yrmU',
  gopVatSheet: { sheetId: 0, range: 'A1:P' },
  khopMaSheet: { sheetId: 1192158065, range: 'A1:K' },
  // So dong tieu de bo qua: Gop VAT co 1 dong header; Khop ma co 1 dong ghi chu
  // ('Đỏ cao quá' / 'Vàng thấp quá') roi moi toi header.
  gopVatSkipRows: 1,
  khopMaSkipRows: 2,
  // Doc theo CHU CAI cot (khong theo ten header). Chen/xoa cot trong sheet thi sua o day.
  gopVatColumns: {
    'NGUỒN': 'A',
    'Mã kiot đại diện': 'B',
    'Tên kiot đại diện': 'C',
    'MÃ VAT KIOT': 'D',
    'TÊN VAT KIOT': 'E',
    'TÊN KẾ TOÁN': 'F',
    'Đơn vị tính': 'G',
    'TỒN ĐẦU NGÀY': 'I',
    'GIÁ BÁN': 'J',
    'THUẾ VAT': 'K',
    'THUẾ NK': 'L',
    'TỔNG THUẾ MẤT': 'M',
    'TỔNG ĐANG NHÁP': 'N',
    'TỒN CÓ THỂ NHÁP': 'O'
  },
  khopMaColumns: {
    'Mã SP': 'A',
    'Tên SP': 'B',
    'Mã vat kiot': 'J',
    'Tên trước (Giá đầu  - Giá cuối) (VAT)': 'K'
  },

  giaNhapDecimalPlaces: 2,
  // Tie-breaker khi so lan xuat hien bang nhau. (Ten nguon that hien la LUCKY, SHC,
  // TKS THẤP, TKSCAO, VC — khong khop danh sach nay nen thuc te sap theo ten; giu nguyen nhu app cu.)
  sourceTiebreakPriority: ['Vận chuyển', 'MAY', 'SAIGONHANOI', 'CAO', 'Thấp'],
  nameMatchWeights: {
    weightUserTenSp: 0.45,
    weightKhopmaTenSp: 0.25,
    weightTenVatKiot: 0.20,
    weightTenTruocVat: 0.10,
    numberTokenBonus: 8.0,
    sizeTokenBonus: 6.0,
    numberConflictPenalty: 25.0,
    variantConflictPenalty: 15.0,
    reviewThreshold: 55.0
  },

  vietqr: {
    template: 'compact2',
    // Thu tu = thu tu hien trong danh sach chon tai khoan.
    accounts: [
      // --- Tai khoan cong ty ---
      { key: 'vcb_tks_group', label: 'VCB TKS', bankId: 'VCB', accountNo: '1069579742', accountName: 'CONG TY CO PHAN THUONG MAI XUAT NHAP KHAU TKS GROUP' },
      { key: 'tks_group', label: 'MB TKS', bankId: 'MB', accountNo: '606266688888', accountName: 'CONG TY CO PHAN THUONG MAI XUAT NHAP KHAU TKS GROUP' },
      { key: 'mb_vc_ex', label: 'MB VC EX', bankId: 'MB', accountNo: '686345345', accountName: 'CONG TY CO PHAN THUONG MAI VC EXPRESS' },
      { key: 'lucky_house', label: 'MB LUCKY HOUSE', bankId: 'MB', accountNo: '898896886', accountName: 'CONG TY CO PHAN XUAT NHAP KHAU THUONG MAI LUCKY HOUSE' },
      { key: 'shc', label: 'MB SHC', bankId: 'MB', accountNo: '525345345', accountName: 'CONG TY SHC' },
      // --- Ca nhan — thu tu theo file Ngan hang (17/10/2026) ---
      { key: 'ocb_c_nguyet', label: 'OCB NGUYỆT', bankId: 'OCB', accountNo: '0034100123456688', accountName: 'DANG THI ANH NGUYET' },
      { key: 'acb_a_quan', label: 'ACB QUÂN (BILL)', bankId: 'ACB', accountNo: '48206877', accountName: 'NGUYEN VAN QUAN' },
      { key: 'acb_c_nguyet', label: 'ACB NGUYỆT (BILL)', bankId: 'ACB', accountNo: '52256368', accountName: 'DANG THI ANH NGUYET' },
      { key: 'msb_a_duy', label: 'MSB DUY', bankId: 'MSB', accountNo: '80002808041', accountName: 'NGUYEN NGOC DUY' },
      { key: 'msb_a_quan', label: 'MSB QUÂN', bankId: 'MSB', accountNo: '80002809285', accountName: 'NGUYEN VAN QUAN' },
      { key: 'shb_a_duy', label: 'SHB DUY', bankId: 'SHB', accountNo: '1026044272', accountName: 'NGUYEN NGOC DUY' },
      { key: 'shb_c_nguyet', label: 'SHB NGUYỆT', bankId: 'SHB', accountNo: '181833666', accountName: 'DANG THI ANH NGUYET' },
      { key: 'tp_a_duy', label: 'TPB DUY (BILL)', bankId: 'TPB', accountNo: '72104081990', accountName: 'NGUYEN NGOC DUY' },
      { key: 'tp_a_quan', label: 'TPB QUÂN', bankId: 'TPB', accountNo: '10003099363', accountName: 'NGUYEN VAN QUAN' },
      { key: 'vib_a_quan', label: 'VIB QUÂN', bankId: 'VIB', accountNo: '044345', accountName: 'NGUYEN VAN QUAN' },
      { key: 'vib_a_duy', label: 'VIB DUY', bankId: 'VIB', accountNo: '087564570', accountName: 'NGUYEN NGOC DUY' },
      { key: 'vp_a_duy', label: 'VPB DUY MỚI', bankId: 'VPB', accountNo: '706126554', accountName: 'NGUYEN NGOC DUY' },
      { key: 'vp_c_nguyet', label: 'VPB NGUYỆT', bankId: 'VPB', accountNo: '3090345688', accountName: 'DANG THI ANH NGUYET' }
    ],
    // Nguon (cot NGUỒN cua Gop VAT) -> tai khoan mac dinh o che do "Hoa don co VAT".
    sourceAccountMap: {
      'LUCKY': 'lucky_house',
      'SHC': 'shc',
      'TKS THẤP': 'tks_group',
      'TKSCAO': 'tks_group',
      'VC': 'mb_vc_ex'
    },
    // "Don vi ban hang" tren hoa don PDF -> tai khoan cong ty (khop chua chuoi, khong phan biet hoa/thuong/dau).
    sellerAccountMap: [
      { match: ['TKS GROUP'], accounts: ['vcb_tks_group', 'tks_group'] },
      { match: ['VC EXPRESS'], accounts: ['mb_vc_ex'] },
      { match: ['LUCKY HOUSE'], accounts: ['lucky_house'] },
      { match: ['SHC'], accounts: ['shc'] }
    ]
  }
});
