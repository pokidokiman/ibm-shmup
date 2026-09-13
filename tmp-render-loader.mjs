// Temporary loader: redirects the bare 'three' specifier to a local stub so the
// render modules can be exercised in plain Node. Deleted after the smoke test.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stub = pathToFileURL(join(here, 'tmp-three-stub.mjs')).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: stub, shortCircuit: true };
  return next(specifier, context);
}
