import { log } from '../lib/log.mjs';

export function handleTeams(req) {
  log('routes.teams', req.method, req.path);
  return { status: 200, route: 'teams' };
}
