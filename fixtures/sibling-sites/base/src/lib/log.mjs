export function log(scope, ...parts) {
  if (process.env.DEBUG) console.error(`[${scope}]`, ...parts);
}
