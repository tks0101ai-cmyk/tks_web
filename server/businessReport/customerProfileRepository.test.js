'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCustomerProfileRepository, detectImageType } = require('./customerProfileRepository');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0080_customer_notes.sql'), 'utf8');
const DETAILS_MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0084_customer_profile_details.sql'), 'utf8');
const ACTOR = { id: 'u-1', name: 'Quản Lý A' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF = Buffer.from('GIF89a-body');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('report profiles batch includes missing and visit-only customers without notes or image bytes', async () => {
  const { db, repo } = await setup();
  try {
    await repo.saveProfile('a', 'A', { warehouseLocation: 'Kho A', warehouseCount: 2, area: '200m2', competitor: 'X', salesChannels: ['san', 'khac'] }, ACTOR);
    await repo.saveScale('a', 'A', 'very_large', ACTOR);
    await repo.setEditors('a', ['u-2'], ACTOR);
    await repo.setVisitDays('a', ['2026-10-02', '2026-10-01'], ACTOR);
    await repo.setVisitDays('visit-only', ['2026-10-03'], ACTOR);
    await repo.createNote('a', 'PRIVATE NOTE', ACTOR);
    const image = await repo.addImage('a', PNG, ACTOR);
    const result = await repo.getReportProfiles(['a', 'missing', 'visit-only', 'a']);
    assert.deepEqual(result.a, {
      warehouseLocation: 'Kho A', warehouseCount: 2, area: '200m2', competitor: 'X', salesChannels: ['san', 'khac'], warehouseScale: 'very_large',
      editors: [{ userId: 'u-2', userName: 'Sale Hai' }], visitDays: ['2026-10-01', '2026-10-02'], images: [{ id: image.id, url: image.url }]
    });
    assert.deepEqual(result.missing, { warehouseLocation: '', warehouseCount: null, area: '', competitor: '', salesChannels: [], warehouseScale: 'none', editors: [], visitDays: [], images: [] });
    assert.deepEqual(result['visit-only'].visitDays, ['2026-10-03']);
    assert.equal(JSON.stringify(result).includes('PRIVATE NOTE'), false);
    assert.deepEqual(await repo.getReportProfiles([]), {});
  } finally { await db.close(); }
});

test('report profile reads reject missing tables or columns as migration pending', async () => {
  const { db, repo } = await setup({ migrate: false });
  try {
    await assert.rejects(() => repo.getReportProfiles(['a']), { statusCode: 503, code: 'MIGRATION_PENDING' });
    await db.exec(MIGRATION);
    await assert.rejects(() => repo.getReportProfiles(['a']), { statusCode: 503, code: 'MIGRATION_PENDING' });
  } finally { await db.close(); }
});

const USERS = [
  { id: 'u-1', username: 'ql', hoTen: 'Quản Lý A', vaiTro: 'Quản lý', trangThai: 'Đang hoạt động' },
  { id: 'u-2', username: 'sale2', hoTen: 'Sale Hai', vaiTro: 'Nhân viên sale', trangThai: 'Đang hoạt động' },
  { id: 'u-3', username: 'sale3', hoTen: '', vaiTro: 'Nhân viên sale', trangThai: 'Đang hoạt động' },
  { id: 'u-4', username: 'khoa', hoTen: 'Bị khóa', vaiTro: 'Nhân viên sale', trangThai: 'Khóa' },
  { id: 'u-5', username: 'khach', hoTen: 'Khách ngoài', vaiTro: 'Khách', trangThai: 'Đang hoạt động' }
];

async function setup({ migrate = true, at = '2026-10-22T05:00:00Z' } = {}) {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  if (migrate) { await db.exec(MIGRATION); await db.exec(DETAILS_MIGRATION); }
  const clock = { at: new Date(at) };
  const pool = { query: (q, p) => db.query(q, p), connect: async () => ({ query: (q, p) => db.query(q, p), release() {} }) };
  const repo = createCustomerProfileRepository({ pool, now: () => clock.at, userStore: { getAllUsers: async () => USERS } });
  return { db, repo, clock };
}

test('detectImageType nhan dien theo magic byte, tu choi file khac', () => {
  assert.equal(detectImageType(PNG), 'image/png');
  assert.equal(detectImageType(JPEG), 'image/jpeg');
  assert.equal(detectImageType(GIF), 'image/gif');
  assert.equal(detectImageType(WEBP), 'image/webp');
  assert.equal(detectImageType(Buffer.from('<svg></svg>')), null);
  assert.equal(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WAVEfmt ')])), null);
  assert.equal(detectImageType('x'), null);
});

test('area and independent scale updates roundtrip without overwriting each other', async () => {
  const { db, repo } = await setup();
  try {
    const initial = await repo.saveProfile('a', 'A', { area: ' Quận 1 ', warehouseScale: 'large', salesChannels: ['khac'] }, ACTOR);
    assert.equal(initial.area, 'Quận 1');
    assert.equal(initial.warehouseScale, 'none');
    const scaled = await repo.saveScale('a', 'A', 'very_large', ACTOR);
    assert.equal(scaled.area, 'Quận 1');
    assert.deepEqual(scaled.salesChannels, ['khac']);
    await repo.saveProfile('a', 'A', { area: 'x'.repeat(500), warehouseScale: 'invalid' }, ACTOR);
    const current = (await repo.getProfile('a')).profile;
    assert.equal(current.warehouseScale, 'very_large');
    assert.equal(current.area.length, 500);
    await assert.rejects(repo.saveProfile('a', 'A', { area: 'x'.repeat(501) }, ACTOR), { statusCode: 400 });
    await assert.rejects(repo.saveScale('a', 'A', 'huge', ACTOR), { statusCode: 400 });
    await repo.saveScale('scale-first', 'B', 'large', ACTOR);
    await repo.saveProfile('scale-first', 'B', { competitor: 'X' }, ACTOR);
    assert.equal((await repo.getProfile('scale-first')).profile.warehouseScale, 'large');
    await Promise.all([
      repo.saveProfile('a', 'A', { area: 'Concurrent area', competitor: 'Concurrent competitor' }, ACTOR),
      repo.saveScale('a', 'A', 'small', ACTOR)
    ]);
    const concurrent = (await repo.getProfile('a')).profile;
    assert.equal(concurrent.area, 'Concurrent area');
    assert.equal(concurrent.competitor, 'Concurrent competitor');
    assert.equal(concurrent.warehouseScale, 'small');
  } finally { await db.close(); }
});

test('saveProfile upsert + getProfile: mac dinh rong, luu va doc lai dung hinh dang', async () => {
  const { db, repo } = await setup();
  try {
    const empty = await repo.getProfile('chị a');
    assert.deepEqual(empty, { profile: { warehouseLocation: '', area: '', warehouseCount: null, warehouseScale: 'none', competitor: '', salesChannels: [] }, images: [], notes: [], visitDays: [], lastVisit: null, editors: [] });
    const saved = await repo.saveProfile('chị a', 'Chị A', {
      warehouseLocation: ' 12 Lê Lợi ', warehouseCount: '3', warehouseScale: 'medium', competitor: 'Tem X', salesChannels: ['kho_buon', 'san']
    }, ACTOR);
    assert.deepEqual(saved, { warehouseLocation: '12 Lê Lợi', area: '', warehouseCount: 3, warehouseScale: 'none', competitor: 'Tem X', salesChannels: ['san', 'kho_buon'] });
    await repo.saveProfile('chị a', 'Chị A', { warehouseCount: null, warehouseScale: 'none', salesChannels: [] }, { id: 'u-2', name: 'Sale Hai' });
    const again = await repo.getProfile('chị a');
    assert.deepEqual(again.profile, { warehouseLocation: '', area: '', warehouseCount: null, warehouseScale: 'none', competitor: '', salesChannels: [] });
    const { rows } = await db.query('SELECT count(*)::int AS n, max(updated_by_id) AS who FROM customer_profiles');
    assert.deepEqual(rows[0], { n: 1, who: 'u-2' });
    await assert.rejects(repo.saveScale('chị a', 'Chị A', 'huge', ACTOR), { statusCode: 400, code: 'INVALID_PROFILE' });
    await assert.rejects(repo.saveProfile('chị a', 'Chị A', { salesChannels: ['invalid'] }, ACTOR), { statusCode: 400 });
    await assert.rejects(repo.saveProfile('chị a', 'Chị A', { warehouseCount: -1 }, ACTOR), { statusCode: 400 });
    await assert.rejects(repo.saveProfile('chị a', 'Chị A', { competitor: 'x'.repeat(501) }, ACTOR), { statusCode: 400 });
  } finally { await db.close(); }
});

test('note: moi khach 1 note/ngay VN (trung => 409), chi sua trong ngay, qua ngay VN thi khoa', async () => {
  const { db, repo, clock } = await setup({ at: '2026-10-22T05:00:00Z' });
  try {
    const first = await repo.createNote('chị a', '  Gặp chị A, hẹn tuần sau  ', ACTOR);
    assert.equal(first.noteDate, '2026-10-22');
    assert.equal(first.body, 'Gặp chị A, hẹn tuần sau');
    assert.equal(first.authorId, 'u-1');
    assert.equal(first.authorName, 'Quản Lý A');
    assert.equal(first.createdAt, '2026-10-22T05:00:00.000Z');
    await assert.rejects(repo.createNote('chị a', 'Note thứ hai', ACTOR), { statusCode: 409, code: 'NOTE_EXISTS_TODAY' });
    // Khach khac cung ngay van tao duoc.
    await repo.createNote('anh b', 'Khách khác', ACTOR);

    clock.at = new Date('2026-10-22T16:00:00Z'); // 23:00 VN van cung ngay
    const edited = await repo.updateNote('chị a', first.id, 'Đã sửa', { id: 'u-2', name: 'Sale Hai' });
    assert.equal(edited.body, 'Đã sửa');
    assert.equal(edited.authorId, 'u-1', 'giu nguyen tac gia');
    assert.equal(edited.updatedAt, '2026-10-22T16:00:00.000Z');
    await assert.rejects(repo.updateNote('chị a', first.id, '   '), { statusCode: 400, code: 'INVALID_NOTE' });
    await assert.rejects(repo.updateNote('chị a', first.id, 'x'.repeat(2001)), { statusCode: 400 });
    await assert.rejects(repo.updateNote('anh b', first.id, 'Sai khách'), { statusCode: 404, code: 'NOTE_NOT_FOUND' });
    await assert.rejects(repo.updateNote('chị a', '99999999-9999-4999-8999-999999999999', 'x'), { statusCode: 404, code: 'NOTE_NOT_FOUND' });

    clock.at = new Date('2026-10-22T17:30:00Z'); // 00:30 ngay 23 gio VN
    assert.equal(repo.today(), '2026-10-23');
    await assert.rejects(repo.updateNote('chị a', first.id, 'Quá ngày'), { statusCode: 409, code: 'NOTE_LOCKED' });
    const second = await repo.createNote('chị a', 'Note ngày mới', ACTOR);
    assert.equal(second.noteDate, '2026-10-23');

    const data = await repo.getProfile('chị a');
    assert.deepEqual(data.notes.map(n => n.noteDate), ['2026-10-23', '2026-10-22'], 'moi nhat o tren');
    assert.deepEqual(data.notes.map(n => n.body), ['Note ngày mới', 'Đã sửa']);
  } finally { await db.close(); }
});

test('setVisitDays thay toan bo tap ngay, bo trung, tinh lastVisit, chan ngay tuong lai / sai dinh dang', async () => {
  const { db, repo } = await setup({ at: '2026-10-22T05:00:00Z' });
  try {
    const a = await repo.setVisitDays('chị a', ['2026-10-20', '2026-10-01', '2026-10-20'], ACTOR);
    assert.deepEqual(a, { visitDays: ['2026-10-01', '2026-10-20'], lastVisit: '2026-10-20' });
    const b = await repo.setVisitDays('chị a', ['2026-10-01', '2026-10-22'], { id: 'u-9', name: 'Khác' });
    assert.deepEqual(b, { visitDays: ['2026-10-01', '2026-10-22'], lastVisit: '2026-10-22' });
    const { rows } = await db.query(`SELECT to_char(visit_date, 'YYYY-MM-DD') AS d, set_by_id FROM customer_visit_days WHERE customer_key = 'chị a' ORDER BY visit_date`);
    assert.deepEqual(rows, [{ d: '2026-10-01', set_by_id: 'u-1' }, { d: '2026-10-22', set_by_id: 'u-9' }], 'ngay giu nguyen thi giu nguoi dat ban dau');
    await repo.setVisitDays('anh b', ['2026-09-09'], ACTOR);
    assert.deepEqual((await repo.getProfile('chị a')).visitDays, ['2026-10-01', '2026-10-22']);
    assert.deepEqual(await repo.setVisitDays('chị a', [], ACTOR), { visitDays: [], lastVisit: null });
    assert.equal((await repo.getProfile('chị a')).lastVisit, null);
    assert.deepEqual((await repo.getProfile('anh b')).visitDays, ['2026-09-09']);

    for (const dates of [['2026-10-23'], ['2026-13-01'], ['2026-02-30'], ['22/10/2026'], [20261022], 'x', null, Array.from({ length: 401 }, (_, i) => `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`).concat(['2024-01-01'])]) {
      await assert.rejects(repo.setVisitDays('chị a', dates, ACTOR), { statusCode: 400, code: 'INVALID_VISIT_DATES' }, JSON.stringify(dates).slice(0, 40));
    }
    // Ranh gioi gio VN: 17:30 UTC ngay 22 la ngay 23 VN => 23 hop le.
    const late = await setup({ at: '2026-10-22T17:30:00Z' });
    try { assert.equal((await late.repo.setVisitDays('k', ['2026-10-23'], ACTOR)).lastVisit, '2026-10-23'); } finally { await late.db.close(); }
  } finally { await db.close(); }
});

test('getMeta: chi khach co du lieu, lastVisit = ngay lon nhat, noteCount; khach chi co note / chi co ngay van co mat', async () => {
  const { db, repo } = await setup();
  try {
    assert.deepEqual(await repo.getMeta(), {});
    await repo.setVisitDays('chị a', ['2026-10-01', '2026-10-15'], ACTOR);
    await repo.createNote('chị a', 'n1', ACTOR);
    await repo.createNote('anh b', 'n2', ACTOR);
    await repo.setVisitDays('cô c', ['2026-09-30'], ACTOR);
    assert.deepEqual(await repo.getMeta(), {
      'chị a': { lastVisit: '2026-10-15', noteCount: 1 },
      'anh b': { lastVisit: null, noteCount: 1 },
      'cô c': { lastVisit: '2026-09-30', noteCount: 0 }
    });
  } finally { await db.close(); }
});

test('nguoi sua: setEditors thay toan bo, chup ten, chi nhan tai khoan noi bo dang hoat dong; isEditor', async () => {
  const { db, repo } = await setup();
  try {
    const assignable = await repo.listAssignableUsers();
    assert.deepEqual(assignable.map(u => u.id).sort(), ['u-1', 'u-2', 'u-3']);
    assert.deepEqual(assignable.find(u => u.id === 'u-3'), { id: 'u-3', hoTen: 'sale3', vaiTro: 'Nhân viên sale' }, 'ten rong => username');
    assert.equal(await repo.isEditor('chị a', 'u-2'), false);
    assert.deepEqual(await repo.setEditors('chị a', ['u-2', 'u-3', 'u-2'], ACTOR), [
      { userId: 'u-2', userName: 'Sale Hai' }, { userId: 'u-3', userName: 'sale3' }
    ]);
    assert.equal(await repo.isEditor('chị a', 'u-2'), true);
    assert.equal(await repo.isEditor('chị a', 3), false);
    assert.equal(await repo.isEditor('anh b', 'u-2'), false, 'gan theo tung khach');
    assert.equal(await repo.isEditor('chị a', undefined), false);
    await repo.setEditors('anh b', ['u-2'], ACTOR);
    assert.deepEqual(await repo.setEditors('chị a', ['u-3'], ACTOR), [{ userId: 'u-3', userName: 'sale3' }]);
    assert.equal(await repo.isEditor('chị a', 'u-2'), false);
    assert.equal(await repo.isEditor('anh b', 'u-2'), true, 'khach khac khong bi anh huong');
    assert.deepEqual((await repo.getProfile('chị a')).editors, [{ userId: 'u-3', userName: 'sale3' }]);
    for (const ids of [['u-4'], ['u-5'], ['khong-co'], 'u-2', [''], [null]]) {
      await assert.rejects(repo.setEditors('chị a', ids, ACTOR), { statusCode: 400, code: 'INVALID_EDITORS' }, JSON.stringify(ids));
    }
    assert.deepEqual(await repo.setEditors('chị a', [], ACTOR), []);
    assert.deepEqual((await repo.getProfile('chị a')).editors, []);
  } finally { await db.close(); }
});

test('anh: kiem magic byte + kich co + toi da 10 anh/khach, doc/xoa dung khach', async () => {
  const { db, repo } = await setup();
  try {
    const img = await repo.addImage('chị a', PNG, ACTOR);
    assert.equal(img.contentType, 'image/png');
    assert.equal(img.byteSize, PNG.length);
    assert.equal(img.url, `/api/business-report/customer-profile/images/${img.id}`);
    assert.match(img.createdAt, /^2026-10-22T05:00:00\.000Z$/);
    const jpeg = await repo.addImage('chị a', JPEG, ACTOR);
    assert.equal(jpeg.contentType, 'image/jpeg');
    assert.equal((await repo.addImage('chị a', GIF, ACTOR)).contentType, 'image/gif');
    assert.equal((await repo.addImage('chị a', WEBP, ACTOR)).contentType, 'image/webp');

    await assert.rejects(repo.addImage('chị a', Buffer.from('<svg onload=alert(1)>'), ACTOR), { statusCode: 400, code: 'IMAGE_INVALID' });
    await assert.rejects(repo.addImage('chị a', Buffer.alloc(0), ACTOR), { statusCode: 400, code: 'IMAGE_MISSING' });
    await assert.rejects(repo.addImage('chị a', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), ACTOR), { statusCode: 413, code: 'IMAGE_TOO_LARGE' });

    const meta = await repo.getImageMeta(img.id);
    assert.equal(meta.contentType, 'image/png');
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await repo.getImageContent(img.id), PNG);
    assert.equal(await repo.getImageMeta('99999999-9999-4999-8999-999999999999'), null);
    assert.equal(await repo.getImageContent('99999999-9999-4999-8999-999999999999'), null);

    const listed = (await repo.getProfile('chị a')).images;
    assert.equal(listed.length, 4);
    assert.ok(listed.some(i => i.id === img.id) && listed.some(i => i.id === jpeg.id));
    assert.deepEqual((await repo.getProfile('anh b')).images, []);

    // Toi da 10 anh / khach; khach khac khong bi tinh chung.
    for (let i = 0; i < 6; i++) await repo.addImage('chị a', PNG, ACTOR);
    await assert.rejects(repo.addImage('chị a', PNG, ACTOR), { statusCode: 409, code: 'IMAGE_LIMIT' });
    await repo.addImage('anh b', PNG, ACTOR);

    await assert.rejects(repo.deleteImage('anh b', img.id), { statusCode: 404, code: 'IMAGE_NOT_FOUND' });
    assert.equal(await repo.deleteImage('chị a', img.id), true);
    assert.equal(await repo.getImageMeta(img.id), null);
    await repo.addImage('chị a', PNG, ACTOR); // xoa 1 thi them lai duoc
  } finally { await db.close(); }
});

test('chua migrate (thieu bang): doc tra rong, ghi tra 503 MIGRATION_PENDING', async () => {
  const { db, repo } = await setup({ migrate: false });
  try {
    assert.deepEqual(await repo.getMeta(), {});
    assert.deepEqual(await repo.getProfile('chị a'), { profile: { warehouseLocation: '', area: '', warehouseCount: null, warehouseScale: 'none', competitor: '', salesChannels: [] }, images: [], notes: [], visitDays: [], lastVisit: null, editors: [] });
    assert.equal(await repo.isEditor('chị a', 'u-2'), false);
    assert.equal(await repo.getImageMeta('99999999-9999-4999-8999-999999999999'), null);
    const pending = { statusCode: 503, code: 'MIGRATION_PENDING' };
    await assert.rejects(repo.saveProfile('chị a', 'Chị A', {}, ACTOR), pending);
    await assert.rejects(repo.saveScale('chị a', 'Chị A', 'large', ACTOR), pending);
    await assert.rejects(repo.createNote('chị a', 'x', ACTOR), pending);
    await assert.rejects(repo.updateNote('chị a', '99999999-9999-4999-8999-999999999999', 'x'), pending);
    await assert.rejects(repo.addImage('chị a', PNG, ACTOR), pending);
    await assert.rejects(repo.deleteImage('chị a', '99999999-9999-4999-8999-999999999999'), pending);
    await assert.rejects(repo.setVisitDays('chị a', ['2026-10-01'], ACTOR), pending);
    await assert.rejects(repo.setEditors('chị a', ['u-2'], ACTOR), pending);
  } finally { await db.close(); }
});

test('0084 pending: absent area column reads fail-soft and both profile writes return migration pending', async () => {
  const { db, repo } = await setup({ migrate: false });
  try {
    await db.exec(MIGRATION);
    await db.query(`INSERT INTO customer_profiles (customer_key, competitor) VALUES ('a', 'Keep')`);
    assert.equal((await repo.getProfile('a')).profile.area, '');
    const pending = { statusCode: 503, code: 'MIGRATION_PENDING' };
    await assert.rejects(repo.saveProfile('a', 'A', { area: 'District' }, ACTOR), pending);
    await assert.rejects(repo.saveScale('a', 'A', 'large', ACTOR), pending);
    assert.deepEqual((await db.query(`SELECT warehouse_scale, competitor FROM customer_profiles`)).rows[0], { warehouse_scale: 'none', competitor: 'Keep' });
  } finally { await db.close(); }
});
