'use strict';

// Explicit one-time cutover; default is read-only preview. Never change KiotViet emails.
const { createRepository } = require('../businessReport/businessReportRepository');
const { createCustomerPriceLevelRepository } = require('../businessReport/customerPriceLevelRepository');
const { getPool } = require('../db/pool');

async function main() {
  const pool = getPool();
  try {
    const snapshot = await createRepository({ pool, legacyLevels: true }).snapshot();
    if (!process.argv.includes('--apply')) {
      const sources = (await pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n;
      console.log(JSON.stringify({ mode: 'preview', sourceProfiles: sources, message: 'Chưa thay đổi dữ liệu. Dùng --apply sau khi áp migration 0087 để lưu nguồn và chuyển sang level nội bộ.' }));
      return;
    }
    if (snapshot.notReady) throw new Error('Báo cáo doanh số chưa sẵn sàng; chưa thể giữ đúng level đang hiển thị. Hoàn tất dựng dữ liệu trước khi khởi tạo.');
    console.log(JSON.stringify({ mode: 'applied', ...await createCustomerPriceLevelRepository({ pool }).initialize(snapshot) }));
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { main };
