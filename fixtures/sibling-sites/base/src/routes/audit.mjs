import { log } from '../lib/log.mjs';

export function handleAudit(req) {
  log('routes.audit', req.method, req.path);
  return { status: 200, route: 'audit' };
}
