import { log } from '../lib/log.mjs';

export function handleAgents(req) {
  log('routes.agents', req.method, req.path);
  return { status: 200, route: 'agents' };
}
