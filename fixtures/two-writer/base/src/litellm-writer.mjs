// Writes one usage row from a litellm completion, inline on the response path.
export function writeLitellmUsage(db, response) {
  db.push({ source: 'litellm', input_tokens: response.usage?.prompt_tokens ?? null, cost: response.cost || 0 });
}
