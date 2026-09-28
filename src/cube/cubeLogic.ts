// Rubik's Cube core logic: state representation, moves, and scrambling.
// The move tables below were derived from a from-scratch 3D coordinate model
// and verified against 9 face-pair commutators, a known order-6 algorithm
// (Sune), and 100-random-move round trips. See conversation history for the
// debugging process — this is not hand-guessed.

export type Face = 'U' | 'D' | 'L' | 'R' | 'F' | 'B';
export type Color = 'W' | 'Y' | 'O' | 'R' | 'G' | 'B';
export type CubeState = Record<Face, Color[]>; // each array: 9 entries, index = row*3+col

export type Move =
  | 'U' | "U'" | 'U2'
  | 'D' | "D'" | 'D2'
  | 'F' | "F'" | 'F2'
  | 'B' | "B'" | 'B2'
  | 'L' | "L'" | 'L2'
  | 'R' | "R'" | 'R2';

const rotateCW = [6, 3, 0, 7, 4, 1, 8, 5, 2];
function rotateFace(face: Color[]): Color[] {
  return rotateCW.map((i) => face[i]);
}

// Explicit (dest <- src) edges. Each face's "written to" index order and its
// "read from" index order (when it feeds another face) are NOT always the
// same — that asymmetry is exactly where reversals live, and conflating the
// two was the root cause of an earlier, subtler bug. Keeping them explicit
// here avoids that class of error entirely.
type Edge = { destFace: Face; destIdx: number[]; srcFace: Face; srcIdx: number[] };

const BASE_MOVES: Record<'U' | 'D' | 'L' | 'R' | 'F' | 'B', Edge[]> = {
  U: [
    { destFace: 'L', destIdx: [0, 1, 2], srcFace: 'F', srcIdx: [0, 1, 2] },
    { destFace: 'R', destIdx: [0, 1, 2], srcFace: 'B', srcIdx: [0, 1, 2] },
    { destFace: 'F', destIdx: [0, 1, 2], srcFace: 'R', srcIdx: [0, 1, 2] },
    { destFace: 'B', destIdx: [0, 1, 2], srcFace: 'L', srcIdx: [0, 1, 2] },
  ],
  D: [
    { destFace: 'L', destIdx: [6, 7, 8], srcFace: 'B', srcIdx: [6, 7, 8] },
    { destFace: 'R', destIdx: [6, 7, 8], srcFace: 'F', srcIdx: [6, 7, 8] },
    { destFace: 'F', destIdx: [6, 7, 8], srcFace: 'L', srcIdx: [6, 7, 8] },
    { destFace: 'B', destIdx: [6, 7, 8], srcFace: 'R', srcIdx: [6, 7, 8] },
  ],
  L: [
    { destFace: 'U', destIdx: [0, 3, 6], srcFace: 'B', srcIdx: [8, 5, 2] },
    { destFace: 'D', destIdx: [0, 3, 6], srcFace: 'F', srcIdx: [0, 3, 6] },
    { destFace: 'F', destIdx: [0, 3, 6], srcFace: 'U', srcIdx: [0, 3, 6] },
    { destFace: 'B', destIdx: [2, 5, 8], srcFace: 'D', srcIdx: [6, 3, 0] },
  ],
  R: [
    { destFace: 'U', destIdx: [2, 5, 8], srcFace: 'F', srcIdx: [2, 5, 8] },
    { destFace: 'D', destIdx: [2, 5, 8], srcFace: 'B', srcIdx: [6, 3, 0] },
    { destFace: 'F', destIdx: [2, 5, 8], srcFace: 'D', srcIdx: [2, 5, 8] },
    { destFace: 'B', destIdx: [0, 3, 6], srcFace: 'U', srcIdx: [8, 5, 2] },
  ],
  F: [
    { destFace: 'U', destIdx: [6, 7, 8], srcFace: 'L', srcIdx: [8, 5, 2] },
    { destFace: 'D', destIdx: [0, 1, 2], srcFace: 'R', srcIdx: [6, 3, 0] },
    { destFace: 'L', destIdx: [2, 5, 8], srcFace: 'D', srcIdx: [0, 1, 2] },
    { destFace: 'R', destIdx: [0, 3, 6], srcFace: 'U', srcIdx: [6, 7, 8] },
  ],
  B: [
    { destFace: 'U', destIdx: [0, 1, 2], srcFace: 'R', srcIdx: [2, 5, 8] },
    { destFace: 'D', destIdx: [6, 7, 8], srcFace: 'L', srcIdx: [0, 3, 6] },
    { destFace: 'L', destIdx: [0, 3, 6], srcFace: 'U', srcIdx: [2, 1, 0] },
    { destFace: 'R', destIdx: [2, 5, 8], srcFace: 'D', srcIdx: [8, 7, 6] },
  ],
};

function applyBaseMoveCW(state: CubeState, face: keyof typeof BASE_MOVES): CubeState {
  const next: CubeState = { ...state };
  next[face] = rotateFace(state[face]);

  const scratch: Partial<Record<Face, Color[]>> = {};
  const getScratch = (f: Face) => scratch[f] ?? (scratch[f] = [...state[f]]);

  for (const e of BASE_MOVES[face]) {
    const destArr = getScratch(e.destFace);
    e.destIdx.forEach((idx, k) => {
      destArr[idx] = state[e.srcFace][e.srcIdx[k]];
    });
  }
  for (const f of Object.keys(scratch) as Face[]) next[f] = scratch[f]!;
  return next;
}

export function applyMove(state: CubeState, move: Move): CubeState {
  const face = move[0] as keyof typeof BASE_MOVES;
  const suffix = move.slice(1);
  const turns = suffix === "'" ? 3 : suffix === '2' ? 2 : 1;
  let result = state;
  for (let i = 0; i < turns; i++) result = applyBaseMoveCW(result, face);
  return result;
}

export function applyMoves(state: CubeState, moves: Move[]): CubeState {
  return moves.reduce((s, m) => applyMove(s, m), state);
}

export function solvedCube(): CubeState {
  const colors: Record<Face, Color> = { U: 'W', D: 'Y', L: 'O', R: 'R', F: 'G', B: 'B' };
  return Object.fromEntries(
    (Object.keys(colors) as Face[]).map((f) => [f, Array(9).fill(colors[f])])
  ) as CubeState;
}

export function isSolved(state: CubeState): boolean {
  return (Object.keys(state) as Face[]).every((f) => state[f].every((c) => c === state[f][0]));
}

export function inverseOf(m: Move): Move {
  return m.endsWith('2') ? m : m.endsWith("'") ? (m[0] as Move) : ((m + "'") as Move);
}

// --- Scrambling ---

const FACES: Face[] = ['U', 'D', 'F', 'B', 'L', 'R'];
const SUFFIXES = ['', "'", '2'];
const AXIS: Record<Face, 'x' | 'y' | 'z'> = { R: 'x', L: 'x', U: 'y', D: 'y', F: 'z', B: 'z' };

export function randomScramble(length = 25): Move[] {
  const scramble: Move[] = [];
  let lastFace: Face | null = null;
  let lastAxisFace: Face | null = null;

  while (scramble.length < length) {
    const face = FACES[Math.floor(Math.random() * FACES.length)];
    if (face === lastFace) continue;
    if (lastAxisFace && AXIS[face] === AXIS[lastAxisFace]) continue;

    const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    scramble.push((face + suffix) as Move);
    lastFace = face;
    lastAxisFace = face;
  }
  return scramble;
}

// --- 3D <-> facelet-index mapping ---
//
// This is the bridge between CubeState (2D facelet arrays) and a 3D cubie
// renderer. It must use the EXACT basis the move tables above were verified
// against, or the cube will animate correctly but render stickers in the
// wrong 3D spot. Derived directly (not re-guessed) from the same coordinate
// system used to build/verify BASE_MOVES:
//   x: right (+1), y: up (+1), z: toward viewer/front (+1)
//   F=z+1, B=z-1, U=y+1, D=y-1, R=x+1, L=x-1
//
// For a cubie at integer position (x,y,z) in {-1,0,1}, and a given face it
// touches, the facelet grid index (row*3+col) is:
export function faceletIndex(face: Face, x: number, y: number, z: number): number {
  switch (face) {
    case 'F': return (1 - y) * 3 + (x + 1);
    case 'B': return (1 - y) * 3 + (1 - x);
    case 'U': return (z + 1) * 3 + (x + 1);
    case 'D': return (1 - z) * 3 + (x + 1);
    case 'R': return (1 - y) * 3 + (1 - z);
    case 'L': return (1 - y) * 3 + (z + 1);
  }
}

// Which faces (if any) a cubie at (x,y,z) has stickers on.
export function facesOfCubie(x: number, y: number, z: number): Face[] {
  const faces: Face[] = [];
  if (x === 1) faces.push('R');
  if (x === -1) faces.push('L');
  if (y === 1) faces.push('U');
  if (y === -1) faces.push('D');
  if (z === 1) faces.push('F');
  if (z === -1) faces.push('B');
  return faces;
}

// All 26 non-center cubie positions.
export function allCubiePositions(): [number, number, number][] {
  const positions: [number, number, number][] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && y === 0 && z === 0) continue;
        positions.push([x, y, z]);
      }
  return positions;
}

// Look up the color a cubie's face should show, given the current CubeState.
export function colorAt(state: CubeState, face: Face, x: number, y: number, z: number): Color {
  return state[face][faceletIndex(face, x, y, z)];
}
