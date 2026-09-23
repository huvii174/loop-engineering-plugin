import { log } from '../lib/log.mjs';

export function handleExports(req) {
  log('routes.exports', req.method, req.path);
  return { status: 200, route: 'exports' };
}
