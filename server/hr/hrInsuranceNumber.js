'use strict';

// "Không đóng" = nhan danh dau cho nhan su KHONG tham gia bao hiem. Nhieu nguoi
// cung mang gia tri nay nen no PHAI duoc mien khoi rang buoc duy nhat — o ca ba
// noi: tien kiem khi sua ho so, tien kiem khi import Excel, va unique index trong
// DB. Lech mot trong ba noi la lai ra 23505 -> 500 nhu su co 10/11/2026.
//
// KHONG quy ve chuoi rong: chuoi rong nghia la CHUA NHAP, con "Không đóng" la da
// xac nhan khong dong — hai trang thai khac han nhau tren bang nhan su.
const NOT_ENROLLED = 'Không đóng';

// Bo dau, bo hoa thuong, gom khoang trang — de "KHÔNG ĐÓNG", "khong dong",
// "Ko đóng BHXH" deu nhan ra la cung mot y.
function fold(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOT_ENROLLED_PATTERN = /^(khong|ko|k)\s?dong(\s?(bh|bhxh|bao hiem))?$/;

function isNotEnrolled(value) {
  return NOT_ENROLLED_PATTERN.test(fold(value));
}

// Quy MOI bien the ve dung mot chuoi, nho vay unique index chi can loai tru mot
// gia tri duy nhat thay vi phai bo dau trong SQL. So bao hiem that giu nguyen
// van ban nguoi dung go (ke ca dau cham cuoi), chi cat khoang trang hai dau.
function normalizeInsuranceNumber(value) {
  const text = String(value ?? '').trim();
  return isNotEnrolled(text) ? NOT_ENROLLED : text;
}

module.exports = { NOT_ENROLLED, isNotEnrolled, normalizeInsuranceNumber, fold };
