import { log } from '../lib/log.mjs';

export function handleSettings(req) {
  log('routes.settings', req.method, req.path);
  return { status: 200, route: 'settings' };
}
