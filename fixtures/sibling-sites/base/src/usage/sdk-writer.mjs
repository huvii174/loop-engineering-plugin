import { log } from '../lib/log.mjs';

// Writes one usage row from an Anthropic SDK response.
export function writeSdkUsage(db, usage) {
  log('usage.sdk', usage.model);
  db.push({ source: 'sdk', model: usage.model, input_tokens: usage.input_tokens ?? null, cost: usage.cost || 0 });
}
