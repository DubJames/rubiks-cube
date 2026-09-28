// Pure drag-to-turn geometry, kept separate from React so it can be tested
// (see verifyDrag.ts). Everything here works in screen PIXELS with y pointing
// up — not normalized device coords, which stretch differently on x and y and
// distort drag direction on tall phone screens.
import * as THREE from 'three';

export type Axis = 'x' | 'y' | 'z';
export interface Vec2 { x: number; y: number }
export interface Viewport { width: number; height: number }
export interface DragCandidate { axis: Axis; layer: number }
export interface Tangent extends DragCandidate { unitPx: Vec2; lengthPx: number }
export interface AxisChoice extends DragCandidate { tangentDirPx: Vec2; alignment: number }

/** A full quarter turn takes this fraction of the canvas's SHORTER side of finger travel. */
export const DRAG_QUARTER_FRACTION = 0.3;
export const MAX_OVERDRAG = 1.15;
/** Release past this fraction of a quarter turn to commit; less springs back. */
export const COMMIT_PROGRESS = 0.5;
// Radius of a sphere comfortably containing the cube (corner radius is ~2.55).
const CUBE_FIT_RADIUS = 2.7;
// A candidate whose on-screen tangent is much shorter than the other's is
// pointing mostly at/away from the camera — not something a finger can follow.
const MIN_RELATIVE_TANGENT_LENGTH = 0.2;

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

export function unitVector(axis: Axis, sign = 1): THREE.Vector3 {
  return new THREE.Vector3().setComponent(AXIS_INDEX[axis], sign);
}

/** On-screen direction (pixels, y up) of a small move along `dir` at `point`. */
export function screenDirPx(
  camera: THREE.Camera,
  viewport: Viewport,
  point: THREE.Vector3,
  dir: THREE.Vector3
): Vec2 {
  const eps = 0.05;
  const a = point.clone().project(camera);
  const b = point.clone().addScaledVector(dir, eps).project(camera);
  return { x: ((b.x - a.x) * viewport.width) / 2, y: ((b.y - a.y) * viewport.height) / 2 };
}

/**
 * For each candidate rotation axis, the on-screen direction a sticker at the
 * clicked point moves when `progress` is POSITIVE.
 *
 * Positive progress means rotating the layer by baseDir * 90deg about +axis,
 * where baseDir = (layer === 1 ? -1 : 1) — the same convention the renderer
 * uses for animation, so "positive progress" == the plain (non-prime) move.
 * A sticker at position p on a face with outward normal n moves in-plane along
 * (axis x n) for a right-handed rotation about +axis. Both baseDir AND the sign
 * of the face normal matter; missing either flips the drag direction on the
 * L / D / B layers and faces.
 */
export function candidateTangents(
  camera: THREE.Camera,
  viewport: Viewport,
  cubiePos: THREE.Vector3,
  faceNormal: THREE.Vector3, // signed outward normal of the clicked face
  candidates: DragCandidate[]
): Tangent[] {
  const stickerPoint = cubiePos.clone().addScaledVector(faceNormal, 0.5);
  return candidates.map((c) => {
    const baseDir = c.layer === 1 ? -1 : 1;
    // Velocity of a rotating point is (axis × position), not (axis × face
    // normal) — those only coincide when the point's position is parallel to
    // the face normal (edge/center cubies aligned with that axis). For a
    // corner cubie they diverge, which is exactly why this bug only showed
    // up on some corner+camera combinations and not on edges.
    const tangent3D = unitVector(c.axis).cross(stickerPoint).multiplyScalar(baseDir);
    const s = screenDirPx(camera, viewport, stickerPoint, tangent3D);
    const lengthPx = Math.hypot(s.x, s.y);
    const unitPx = lengthPx > 1e-9 ? { x: s.x / lengthPx, y: s.y / lengthPx } : { x: 0, y: 0 };
    return { ...c, unitPx, lengthPx };
  });
}

/** Pick which candidate layer-turn best matches the drag so far. */
export function chooseDragAxis(args: {
  camera: THREE.Camera;
  viewport: Viewport;
  cubiePos: THREE.Vector3;
  faceNormal: THREE.Vector3;
  candidates: DragCandidate[];
  dragPx: Vec2;
}): AxisChoice | null {
  const { camera, viewport, cubiePos, faceNormal, candidates, dragPx } = args;
  const dist = Math.hypot(dragPx.x, dragPx.y);
  if (dist === 0) return null;

  let tangents = candidateTangents(camera, viewport, cubiePos, faceNormal, candidates);
  if (tangents.length > 1) {
    const maxLen = Math.max(...tangents.map((t) => t.lengthPx));
    tangents = tangents.filter((t) => t.lengthPx >= MIN_RELATIVE_TANGENT_LENGTH * maxLen);
  }

  let best: AxisChoice | null = null;
  for (const t of tangents) {
    const alignment = (dragPx.x * t.unitPx.x + dragPx.y * t.unitPx.y) / dist;
    if (!best || Math.abs(alignment) > Math.abs(best.alignment)) {
      best = { axis: t.axis, layer: t.layer, tangentDirPx: t.unitPx, alignment };
    }
  }
  return best;
}

/** Signed quarter-turn progress for the current drag (clamped to slight overdrag). */
export function dragProgress(dragPx: Vec2, tangentDirPx: Vec2, quarterPx: number): number {
  const raw = (dragPx.x * tangentDirPx.x + dragPx.y * tangentDirPx.y) / quarterPx;
  return Math.max(-MAX_OVERDRAG, Math.min(MAX_OVERDRAG, raw));
}

export function quarterTurnPx(viewport: Viewport): number {
  return DRAG_QUARTER_FRACTION * Math.min(viewport.width, viewport.height);
}

/** Travel needed before an axis is locked in. Fingers jitter more than mice. */
export function lockThresholdPx(pointerType: string): number {
  return pointerType === 'mouse' ? 4 : 10;
}

/** Camera distance at which the whole cube fits, in portrait or landscape. */
export function fitDistance(fovDeg: number, aspect: number): number {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  return CUBE_FIT_RADIUS / Math.sin(Math.min(vHalf, hHalf));
}
