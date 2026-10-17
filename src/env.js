import { loadEnvFile } from 'node:process';

// Local development may use .env; containers receive their environment directly.
// Existing process variables take precedence over file values.
export function loadLocalEnv() {
  try { loadEnvFile('.env'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
