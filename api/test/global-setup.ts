import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Bring the test database up to date before any test file runs.
export default function setup(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch {
    // No .env: rely on the environment (CI).
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
  execFileSync('sh', [fileURLToPath(new URL('../../db/migrate.sh', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
