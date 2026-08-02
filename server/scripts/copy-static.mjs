import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies static/ into dist/public, including the ds/ design-system tree
// (tokens and self-hosted fonts) so the dashboard needs no network.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Not a clean wipe: esbuild has already written the dashboard bundle here.
const out = path.join(root, 'dist', 'public');
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'static'), out, { recursive: true });
