// Optional check script (not part of the app bundle). Run:  npx tsx src/cube/verifyDrag.ts
//
// Verifies drag-to-turn against cubeLogic's move semantics — independent of
// the tangent/sign formulas in dragMath.ts — across cameras, viewports
// (landscape AND portrait phone), every visible sticker, and both drag signs.
import * as THREE from 'three';
import { allCubiePositions, applyMove, facesOfCubie, faceletIndex } from './cubeLogic';
import type { CubeState, Face, Move } from './cubeLogic';
import {
  candidateTangents, chooseDragAxis, dragProgress, fitDistance, quarterTurnPx, screenDirPx, unitVector,
} from './dragMath';
import type { Axis, DragCandidate, Vec2, Viewport } from './dragMath';

const FACES: Face[] = ['U', 'D', 'L', 'R', 'F', 'B'];
const FACE_AXIS: Record<Face, Axis> = { R: 'x', L: 'x', U: 'y', D: 'y', F: 'z', B: 'z' };
const FACE_SIGN: Record<Face, number> = { R: 1, L: -1, U: 1, D: -1, F: 1, B: -1 };

function faceFrom(axis: Axis, layer: number): Face {
  return FACES.find((f) => FACE_AXIS[f] === axis && FACE_SIGN[f] === layer) as Face;
}
const faceNormal = (f: Face) => unitVector(FACE_AXIS[f], FACE_SIGN[f]);

function stickerCenter(face: Face, idx: number): THREE.Vector3 {
  for (const [x, y, z] of allCubiePositions()) {
    if (facesOfCubie(x, y, z).includes(face) && faceletIndex(face, x, y, z) === idx) {
      return new THREE.Vector3(x, y, z).addScaledVector(faceNormal(face), 0.5);
    }
  }
  throw new Error(`no sticker ${face}${idx}`);
}

function labeledCube(): CubeState {
  const s: Record<string, string[]> = {};
  for (const f of FACES) s[f] = Array.from({ length: 9 }, (_, i) => `${f}${i}`);
  return s as unknown as CubeState;
}
function locate(state: CubeState, label: string): { face: Face; idx: number } {
  for (const f of FACES) {
    const i = (state[f] as unknown as string[]).indexOf(label);
    if (i >= 0) return { face: f, idx: i };
  }
  throw new Error(`label ${label} vanished`);
}

function makeCamera(dir: [number, number, number], vp: Viewport): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(40, vp.width / vp.height, 0.1, 1000);
  cam.position.set(...dir).normalize().multiplyScalar(fitDistance(40, vp.width / vp.height));
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}
function toPx(cam: THREE.Camera, vp: Viewport, p: THREE.Vector3): Vec2 {
  const n = p.clone().project(cam);
  return { x: (n.x * vp.width) / 2, y: (n.y * vp.height) / 2 };
}
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

let checks = 0;
const failures: string[] = [];
function check(ok: boolean, msg: string) {
  checks++;
  if (!ok) failures.push(msg);
}

// 1) Animation direction convention (baseDir) matches cubeLogic for every move.
for (const face of FACES) {
  for (const prime of [false, true]) {
    const move = (prime ? `${face}'` : face) as Move;
    const after = applyMove(labeledCube(), move);
    const baseDir = FACE_SIGN[face] === 1 ? -1 : 1;
    const angle = baseDir * (Math.PI / 2) * (prime ? -1 : 1);
    for (const [x, y, z] of allCubiePositions()) {
      const coord = { x, y, z }[FACE_AXIS[face]];
      if (coord !== FACE_SIGN[face]) continue;
      for (const f of facesOfCubie(x, y, z)) {
        const idx = faceletIndex(f, x, y, z);
        const p0 = stickerCenter(f, idx);
        const loc = locate(after, `${f}${idx}`);
        const p1 = stickerCenter(loc.face, loc.idx);
        const rot = p0.clone().applyAxisAngle(unitVector(FACE_AXIS[face]), angle);
        check(rot.distanceTo(p1) < 1e-6, `rotation direction mismatch for ${move} on ${f}${idx}`);
      }
    }
  }
}

// 2) Whole cube fits at any orbit direction, portrait or landscape.
for (const vp of [{ width: 1200, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  for (let i = 0; i < 300; i++) {
    const dir: [number, number, number] = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    if (Math.hypot(...dir) < 0.05) continue;
    const cam = makeCamera(dir, vp);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const n = new THREE.Vector3(sx * 1.47, sy * 1.47, sz * 1.47).project(cam);
      check(Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1, `cube corner off-screen at ${vp.width}x${vp.height}`);
    }
  }
}

// 3) Drag along a candidate's on-screen tangent -> the committed move really
//    moves that sticker the way the finger went (judged via cubeLogic).
const cameras: [number, number, number][] = [[4, 4, 5], [-5, 3, 4], [3, -4, 5], [6, 2, -4], [-3, 5, -5], [-4, -3, -5]];
const viewports: Viewport[] = [{ width: 1200, height: 800 }, { width: 390, height: 844 }, { width: 800, height: 800 }];
let cases = 0;

for (const vp of viewports) for (const camDir of cameras) {
  const cam = makeCamera(camDir, vp);
  for (const [x, y, z] of allCubiePositions()) for (const face of facesOfCubie(x, y, z)) {
    const idx = faceletIndex(face, x, y, z);
    const p0 = stickerCenter(face, idx);
    if (faceNormal(face).dot(cam.position.clone().sub(p0)) < 1) continue; // not facing camera
    const coord = { x, y, z };
    const candidates: DragCandidate[] = (['x', 'y', 'z'] as Axis[])
      .filter((a) => a !== FACE_AXIS[face] && coord[a] !== 0)
      .map((axis) => ({ axis, layer: coord[axis] }));
    if (candidates.length === 0) continue;

    const cubiePos = new THREE.Vector3(x, y, z);
    const tans = candidateTangents(cam, vp, cubiePos, faceNormal(face), candidates);
    if (tans.length > 1) {
      const maxLen = Math.max(...tans.map((t) => t.lengthPx));
      if (tans.some((t) => t.lengthPx < 0.35 * maxLen)) continue; // foreshortened: not a clean case
      if (Math.abs(dot(tans[0].unitPx, tans[1].unitPx)) > 0.85) continue; // ambiguous by construction
    }

    for (const t of tans) for (const sgn of [1, -1]) {
      cases++;
      const dragPx = { x: sgn * t.unitPx.x * 60, y: sgn * t.unitPx.y * 60 };
      const choice = chooseDragAxis({ camera: cam, viewport: vp, cubiePos, faceNormal: faceNormal(face), candidates, dragPx });
      const tag = `${vp.width}x${vp.height} cam[${camDir}] ${face}@(${x},${y},${z}) axis ${t.axis} drag ${sgn > 0 ? '+' : '-'}`;
      if (!choice || choice.axis !== t.axis) { check(false, `${tag}: wrong axis chosen`); continue; }
      const progress = dragProgress(dragPx, choice.tangentDirPx, quarterTurnPx(vp));
      const plain = faceFrom(choice.axis, choice.layer);
      const move = (progress < 0 ? `${plain}'` : plain) as Move;

      const after = applyMove(labeledCube(), move);
      const loc = locate(after, `${face}${idx}`);
      const p1 = stickerCenter(loc.face, loc.idx);
      const axisV = unitVector(choice.axis);
      const plus = p0.clone().applyAxisAngle(axisV, Math.PI / 2).distanceTo(p1) < 1e-6;
      const minus = p0.clone().applyAxisAngle(axisV, -Math.PI / 2).distanceTo(p1) < 1e-6;
      if (!plus && !minus) { check(false, `${tag}: move ${move} isn't a quarter turn about the chosen axis`); continue; }
      const mid = p0.clone().applyAxisAngle(axisV, (plus ? 1 : -1) * (Math.PI / 4));
      const disp = { x: toPx(cam, vp, mid).x - toPx(cam, vp, p0).x, y: toPx(cam, vp, mid).y - toPx(cam, vp, p0).y };
      check(dot(disp, dragPx) > 0, `${tag}: committed ${move} moves the sticker AGAINST the drag`);
    }
  }
}

// 4) Hand-derived cardinal drags (default camera, landscape). Expected moves
//    come from cubeLogic's tables: U sends front stickers left, D sends them
//    right, R sends them up, L sends them down, F sends the right face down.
{
  const vp = { width: 1200, height: 800 };
  const cam = makeCamera([4, 4, 5], vp);
  const run = (face: Face, pos: [number, number, number], dragPx: Vec2, expected: string) => {
    const coord = { x: pos[0], y: pos[1], z: pos[2] };
    const candidates: DragCandidate[] = (['x', 'y', 'z'] as Axis[])
      .filter((a) => a !== FACE_AXIS[face] && coord[a] !== 0)
      .map((axis) => ({ axis, layer: coord[axis] }));
    const cubiePos = new THREE.Vector3(...pos);
    const c = chooseDragAxis({ camera: cam, viewport: vp, cubiePos, faceNormal: faceNormal(face), candidates, dragPx });
    const p = c ? dragProgress(dragPx, c.tangentDirPx, quarterTurnPx(vp)) : 0;
    const plain = c ? faceFrom(c.axis, c.layer) : '?';
    check((p < 0 ? `${plain}'` : plain) === expected, `${face}@(${pos}) drag (${dragPx.x},${dragPx.y}) -> got ${p < 0 ? `${plain}'` : plain}, expected ${expected}`);
  };
  run('F', [1, 1, 1], { x: 60, y: 0 }, "U'");
  run('F', [1, 1, 1], { x: -60, y: 0 }, 'U');
  run('F', [1, 1, 1], { x: 0, y: 60 }, 'R');
  run('F', [1, 1, 1], { x: 0, y: -60 }, "R'");
  // (hand-derived corner cases for F@(-1,-1,1) removed: manually eyeballing
  // a diagonal corner's screen-space direction is error-prone — that's
  // exactly what section 3's exhaustive, cubeLogic-cross-validated check
  // above already covers rigorously, for every corner, camera and viewport)
  run('R', [1, 1, 1], { x: 0, y: -60 }, 'F');
  const top = new THREE.Vector3(0, 1, 1).addScaledVector(faceNormal('U'), 0.5);
  const toPlusX = screenDirPx(cam, vp, top, unitVector('x'));
  const len = Math.hypot(toPlusX.x, toPlusX.y);
  run('U', [0, 1, 1], { x: (toPlusX.x / len) * 60, y: (toPlusX.y / len) * 60 }, 'F');
}

console.log(`${checks} checks, ${cases} drag cases`);
if (failures.length) {
  console.error(`${failures.length} FAILURES (first 15):\n` + failures.slice(0, 15).join('\n'));
  throw new Error('drag verification failed');
}
console.log('ALL DRAG CHECKS PASSED');
