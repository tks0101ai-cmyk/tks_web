'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { fuzzySqlParts, VN_FROM, VN_TO } = require('./fuzzySql');
const fuzzy = require('./fuzzySearch');

test('bảng bỏ dấu SQL khớp hàm fold của JS', () => {
  assert.equal([...VN_FROM].length, [...VN_TO].length);
  [...VN_FROM].forEach((ch, i) => assert.equal(fuzzy.fold(ch), VN_TO[i], ch));
});

test('chạy thật trên Postgres: cùng kết quả với luật JS', async () => {
  const db = new PGlite();
  const texts = ['Nguyễn Văn Đạt', 'Lê Văn Nam', 'Trần Thị Hoa', 'Hà Nội Văn Phòng', null];
  const run = async (q) => {
    const params = [];
    const p = fuzzySqlParts('t', q, (v) => { params.push(v); return `$${params.length}`; });
    const { rows } = await db.query(`SELECT i FROM (SELECT * FROM unnest($${params.length + 1}::text[]) WITH ORDINALITY AS x(t,i)) s(t,i) WHERE ${p.where} ORDER BY ${p.score} DESC, i`, [...params, texts]);
    return rows.map((r) => Number(r.i) - 1);
  };
  for (const q of ['van', 'NGUYEN VAN', 'van dat', 'van zzz', 'hoa thi tran', 'ha noi van']) {
    const expected = fuzzy.filter(texts.map((t, i) => ({ t, i })), q, (x) => x.t).map((x) => x.i);
    assert.deepEqual(await run(q), expected, q);
  }
});

test('SQL: mọi từ phải khớp, cùng kết quả JS (không còn ngưỡng 80%)', async () => {
  const db = new PGlite();
  const texts = ['a b c d e', 'a b c d', 'e d c b a x'];
  for (const q of ['a b c d e', 'a b c d e zzz', 'x a']) {
    const params = [];
    const p = fuzzySqlParts('t', q, (v) => { params.push(v); return `$${params.length}`; });
    const { rows } = await db.query(`SELECT i FROM (SELECT * FROM unnest($${params.length + 1}::text[]) WITH ORDINALITY AS x(t,i)) s(t,i) WHERE ${p.where} ORDER BY i`, [...params, texts]);
    const expected = texts.map((t, i) => [t, i]).filter(([t]) => fuzzy.matches(t, q)).map(([, i]) => i);
    assert.deepEqual(rows.map((r) => Number(r.i) - 1), expected, q);
  }
  assert.deepEqual((await (async () => { const params = []; const p = fuzzySqlParts('t', 'a b c d e zzz', (v) => { params.push(v); return `$${params.length}`; }); return db.query(`SELECT 1 FROM (SELECT $${params.length + 1}::text AS t) s WHERE ${p.where}`, [...params, 'a b c d e']); })()).rows, []);
});

test('folded: true dùng thẳng biểu thức đã bỏ dấu (tính 1 lần / dòng), cùng kết quả + điểm với cách bọc translate từng từ', async () => {
  const { foldSql } = require('./fuzzySql');
  const db = new PGlite();
  const texts = ['Nguyễn Văn Đạt', 'Lê Văn Nam', 'Trần Thị Hoa', 'Hà Nội Văn Phòng', null, 'van  dat'];
  const run = async (q, folded) => {
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    const p = folded ? fuzzySqlParts('f', q, add, { folded: true }) : fuzzySqlParts('t', q, add);
    const { rows } = await db.query(`SELECT i, ${p.score} AS score FROM (SELECT t, i, ${foldSql("COALESCE(t,'')")} AS f
        FROM unnest($${params.length + 1}::text[]) WITH ORDINALITY AS x(t,i)) s WHERE ${p.where} ORDER BY ${p.score} DESC, i`, [...params, texts]);
    return rows.map((r) => [Number(r.i), Number(r.score)]);
  };
  for (const q of ['van', 'NGUYEN VAN', 'van dat', 'van zzz', 'hoa thi tran', 'ha noi van']) {
    assert.deepEqual(await run(q, true), await run(q, false), q);
  }
  const params = [];
  assert.doesNotMatch(fuzzySqlParts('f', 'van dat', (v) => { params.push(v); return `$${params.length}`; }, { folded: true }).score, /translate/);
});
