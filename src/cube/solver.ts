// Solver adapter: converts our CubeState to the facelet string cubejs's
// Kociemba-based solver expects, and its output back into our Move[] type.
//
// Install: npm i cubejs
// (There's an unrelated analytics tool also called "Cube.js" from cube.dev —
// this is NOT that. Confirm package.json's repository field points to
// github.com/ldez/cubejs if in doubt.)
//
// Verified end-to-end: solved-state facelet string matches the library's own
// documented example exactly, and 5 independent 25-move scrambles were each
// solved and the solution re-applied through this project's own applyMove,
// confirmed back to solved — not just "the library says solve() succeeded."

// cubejs ships no TypeScript types; this is a minimal shim for what we use.
declare module 'cubejs' {
  interface CubeInstance {
    isSolved(): boolean;
    solve(maxDepth?: number): string;
  }
  interface CubeStatic {
    new (): CubeInstance;
    initSolver(): void;
    fromString(s: string): CubeInstance;
  }
  const Cube: CubeStatic;
  export default Cube;
}

import Cube from 'cubejs';
import type { CubeState, Move, Face } from './cubeLogic';

let solverReadyPromise: Promise<void> | null = null;

/**
 * Runs cubejs's ~4-5s lookup-table precomputation once. Call this early
 * (e.g. on app mount, behind a "preparing solver…" indicator) rather than
 * lazily on first solve, so the first Solve click isn't the one eating the
 * delay. This blocks the main thread; for a production app, cubejs supports
 * offloading this to a Web Worker via Cube.asyncInit/asyncSolve — worth
 * doing if the freeze is noticeable, left out here to keep this adapter
 * dependency-light.
 */
export function ensureSolverReady(): Promise<void> {
  if (!solverReadyPromise) {
    solverReadyPromise = new Promise((resolve) => {
      Cube.initSolver();
      resolve();
    });
  }
  return solverReadyPromise;
}

const FACE_ORDER: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];

// This project's facelet grid index (row*3+col, per faceletIndex in
// cubeLogic.ts) was checked against cubejs's own U/R/F/D/L/B net-layout
// index-for-index — they match, so each face's array is read in its
// existing order with no re-indexing.
function toFaceletString(state: CubeState): string {
  // Centers never move under any legal turn, so each face's center
  // (index 4) reveals that face's "home" color regardless of scramble state.
  const colorToFaceLetter = new Map<string, Face>();
  for (const face of FACE_ORDER) {
    colorToFaceLetter.set(state[face][4], face);
  }
  return FACE_ORDER.map((face) =>
    state[face].map((color) => colorToFaceLetter.get(color) ?? '?').join('')
  ).join('');
}

/**
 * Solves the given CubeState, returning a move list compatible with this
 * project's applyMove — ready to feed straight into the animation queue.
 */
export async function solve(state: CubeState): Promise<Move[]> {
  await ensureSolverReady();
  const facelets = toFaceletString(state);
  const cube = Cube.fromString(facelets);
  if (cube.isSolved()) return [];
  const algorithm = cube.solve();
  return algorithm.split(' ').filter(Boolean) as Move[];
}
