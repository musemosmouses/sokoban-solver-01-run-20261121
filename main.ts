// main.ts — the driver: read every level in /input, solve each, write
// /output/<id>/solution.txt, creating /output/<id>/ itself.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { solveLevel } from './solver.ts';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const levelPath = join(I, id, 'level.txt');
  if (!existsSync(levelPath)) continue;
  const moves = solveLevel(readFileSync(levelPath, 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

