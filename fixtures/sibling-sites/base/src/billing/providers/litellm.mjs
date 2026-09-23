import { log } from '../../lib/log.mjs';
import { normaliseModel } from '../../lib/models.mjs';

// Settles one litellm completion: normalises the model, derives the charge,
// and appends the usage row inline on the response path.
export function settleLitellm(db, response) {
  const model = normaliseModel(response.model);
  log('billing.litellm', model);
  const charge = typeof response.cost === 'number' ? response.cost : 0;
  const tokens = response.usage?.prompt_tokens ?? null;
  db.push({ source: 'litellm', model, input_tokens: tokens, cost: charge });
  return { model, charge };
}
