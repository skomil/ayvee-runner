import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist', 'public');
fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'static'))) {
  fs.copyFileSync(path.join(root, 'static', file), path.join(out, file));
}
