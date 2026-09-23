// Writes one usage row from an Anthropic SDK response.
export function writeSdkUsage(db, usage) {
  db.push({ source: 'sdk', input_tokens: usage.input_tokens ?? null, cost: usage.cost || 0 });
}
