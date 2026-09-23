import { log } from './log.mjs';
export function normaliseModel(name) {
  log('models', name);
  return String(name ?? 'unknown').toLowerCase();
}
