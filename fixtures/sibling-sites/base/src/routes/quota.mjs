import { log } from '../lib/log.mjs';

export function handleQuota(req) {
  log('routes.quota', req.method, req.path);
  return { status: 200, route: 'quota' };
}
