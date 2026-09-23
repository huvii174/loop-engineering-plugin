import { log } from '../lib/log.mjs';

export function handleSessions(req) {
  log('routes.sessions', req.method, req.path);
  return { status: 200, route: 'sessions' };
}
