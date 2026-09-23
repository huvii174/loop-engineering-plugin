import { log } from '../lib/log.mjs';

export function handleHealth(req) {
  log('routes.health', req.method, req.path);
  return { status: 200, route: 'health' };
}
