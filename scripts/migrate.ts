import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMigration } from '../src/infrastructure/job-repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(__dirname, '../../migrations/001_jobs.sql'), 'utf8');
  await runMigration(sql);
  console.log('Migration applied');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
