'use strict';
// Phep chuan hoa ten cont dung CHUNG cho moi duong ghi (service, seed, nap ban
// chup nguon). product_containers.name_key la UNIQUE va la thu duy nhat chan
// trung ten cont, nen moi noi phai tinh key bang dung ham nay: neu mot duong
// ghi dung lower(btrim(name)) va duong khac dung ban nay thi cung mot ten se
// sinh hai key khac nhau va rang buoc UNIQUE khong con y nghia.
//
// Bo khoang trang (ke ca khoang giua chu), doi '.' thanh '-' va in hoa:
// 'CONT BẾP GA' va 'cont bep  ga' khac nhau o dau cach nhung cung mot cont.
const normalizeName = value => String(value||'').trim().replace(/\s+/g,'').replace(/\./g,'-').toUpperCase();
module.exports = { normalizeName };
