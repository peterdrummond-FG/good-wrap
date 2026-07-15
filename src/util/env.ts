// Small shared helper so pipeline modules fail fast with a clear message
// instead of a cryptic "undefined" error deep in an API call.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to your .env file (see .env.example).`);
  }
  return value;
}
