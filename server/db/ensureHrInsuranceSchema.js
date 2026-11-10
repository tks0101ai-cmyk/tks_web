'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./pool');

const FILENAMES = [
  '0078_hr_employee_insurance_number.sql',
  '0121_hr_insurance_not_enrolled.sql'
];

async function ensureHrInsuranceSchema({ pool = getPool(), logger = console } = {}) {
  const client = await pool.connect();
  const appliedFiles = [];
  try {
    await client.query('BEGIN');
    try {
      // Multiple Render instances can start together. Serialize both HR migrations.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('tokosi'), hashtext('hr_employee_insurance'))");
      for (const filename of FILENAMES) {
        const applied = await client.query(
          'SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]
        );
        if (applied.rowCount) continue;
        const sql = fs.readFileSync(path.join(__dirname, 'migrations', filename), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        appliedFiles.push(filename);
      }
      await client.query('COMMIT');
      for (const filename of appliedFiles) {
        logger.log(`[db:migrate] Applied ${filename} before HTTP startup`);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

module.exports = { ensureHrInsuranceSchema };
