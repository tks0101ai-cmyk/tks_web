// Nap server/.env roi chay index.js hoac worker.js (TOKOSI_ENTRY).
// Dung thay --env-file: co do lam pm2 cluster mode thoat ngay (code 9). dotenv la devDependency nen khong dung duoc o production.
const path = require('path');

const dir = process.env.TOKOSI_APP_DIR || '/root/tokosi_dashboard/server';
process.loadEnvFile(path.join(dir, '.env'));
require(path.join(dir, process.env.TOKOSI_ENTRY));
