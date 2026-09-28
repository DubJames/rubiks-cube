import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  allCubiePositions, facesOfCubie, colorAt,
} from './cubeLogic';
import type { CubeState, Move, Face } from './cubeLogic';
import {
  chooseDragAxis, dragProgress, fitDistance, lockThresholdPx, quarterTurnPx, unitVector,
} from './dragMath';
import type { Axis, DragCandidate, Vec2 } from './dragMath';

const BODY_COLOR = '#111111';
const COLOR_HEX: Record<string, string> = {
  W: '#ffffff', Y: '#ffe000', O: '#ff8c00', R: '#c41e3a', G: '#00a64f', B: '#0051ba',
};

const AXIS: Record<Face, Axis> = { R: 'x', L: 'x', U: 'y', D: 'y', F: 'z', B: 'z' };
const LAYER: Record<Face, number> = { R: 1, L: -1, U: 1, D: -1, F: 1, B: -1 };
const CAMERA_FOV = 40;

// three.js BoxGeometry's default 6 material groups, in order: [+x,-x,+y,-y,+z,-z].
// That's exactly [R, L, U, D, F, B] — and conveniently, intersection.face.materialIndex
// from a raycast hit tells us directly which of the 6 faces was clicked.
const MATERIAL_FACE_ORDER: Face[] = ['R', 'L', 'U', 'D', 'F', 'B'];

function faceFromAxisLayer(axis: Axis, layer: number): Face {
  const table: Record<string, Face> = {
    'x,1': 'R', 'x,-1': 'L', 'y,1': 'U', 'y,-1': 'D', 'z,1': 'F', 'z,-1': 'B',
  };
  return table[`${axis},${layer}`];
}

// --- Cubie ---

interface CubieProps {
  position: [number, number, number];
  cubeState: CubeState;
  onCubiePointerDown?: (e: ThreeEvent<PointerEvent>, cubiePos: [number, number, number], face: Face) => void;
}

function Cubie({ position, cubeState, onCubiePointerDown }: CubieProps) {
  const [x, y, z] = position;
  const present = useMemo(() => new Set(facesOfCubie(x, y, z)), [x, y, z]);

  const materials = useMemo(
    () =>
      MATERIAL_FACE_ORDER.map((face) => {
        const hex = present.has(face) ? COLOR_HEX[colorAt(cubeState, face, x, y, z)] : BODY_COLOR;
        return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.35, metalness: 0.05 });
      }),
    [cubeState, x, y, z, present]
  );

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!onCubiePointerDown || e.face == null) return;
    const face = MATERIAL_FACE_ORDER[e.face.materialIndex];
    if (!present.has(face)) return; // clicked an internal (non-sticker) face
    onCubiePointerDown(e, [x, y, z], face);
  };

  return (
    <mesh position={position} onPointerDown={handlePointerDown}>
      <boxGeometry args={[0.94, 0.94, 0.94]} />
      {materials.map((m, i) => (
        <primitive key={i} object={m} attach={`material-${i}`} />
      ))}
    </mesh>
  );
}

// --- Animation state shared by both queued moves (scramble/solve) and
//     manual drag-turns, so both drive the same visual machinery. ---

interface AnimState {
  move: Move;
  progress: number;       // signed; can exceed [0,1] slightly during live drag overdrag
  targetProgress: number; // 1 = animate to completion and commit; 0 = animate back and cancel
  commit: boolean;        // whether reaching progress===targetProgress should call onMoveComplete
}

const QUEUED_ANIMATION_DURATION_MS = 250;
const SETTLE_DURATION_MS = 120;

interface DragLock {
  axis: Axis;
  layer: number;
  move: Move;              // the "plain" (non-prime) move for this axis+layer
  tangentDirPx: Vec2;      // unit vector, canonical +axis direction on screen, in pixels
  quarterPx: number;       // pixel distance representing a full 90° turn (viewport-scaled)
}

interface CubeSceneProps {
  cubeState: CubeState;
  pendingMove: Move | null;
  onMoveComplete?: (move: Move) => void;
}

function CubeScene({ cubeState, pendingMove, onMoveComplete }: CubeSceneProps) {
  const { camera, gl, size } = useThree();
  const positions = useMemo(() => allCubiePositions(), []);

  const [anim, setAnim] = useState<AnimState | null>(null);
  const animRef = useRef<AnimState | null>(null);
  animRef.current = anim;

  const rotatingGroupRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);

  const dragLockRef = useRef<DragLock | null>(null);
  const dragStartRef = useRef<Vec2 | null>(null);
  const dragCandidateRef = useRef<{
    cubiePos: [number, number, number];
    face: Face;
  } | null>(null);

  // Manual drag-to-turn bookkeeping (all grouped here, up front, rather
  // than scattered near first use).
  const pendingCandidatesRef = useRef<DragCandidate[]>([]);
  const pendingCubieWorldPos = useRef<THREE.Vector3 | null>(null);
  const lockThresholdRef = useRef(4); // recomputed per-pointer (mouse vs touch) on pointerdown
  const lastRawProgressRef = useRef(0);
  const [, setDragTick] = useState(0); // forces the one re-render needed at axis lock-in

  // --- Queue-driven animation (scramble/solve) ---
  useEffect(() => {
    if (pendingMove && !animRef.current) {
      setAnim({ move: pendingMove, progress: 0, targetProgress: 1, commit: true });
    }
  }, [pendingMove]);

  useFrame((_, delta) => {
    const a = animRef.current;
    if (!a) return;
    // Manual-drag frames are driven imperatively (see pointermove handler
    // below), not by this timer — only step time-driven phases here:
    // queued moves, and the post-release "settle" snap/cancel.
    if (dragLockRef.current) return; // live drag in progress; skip timer
    const durationMs = a.commit && a.targetProgress === 1 && a.progress === 0
      ? QUEUED_ANIMATION_DURATION_MS
      : SETTLE_DURATION_MS;
    const step = (delta * 1000) / durationMs;
    const next = a.targetProgress > a.progress
      ? Math.min(a.targetProgress, a.progress + step)
      : Math.max(a.targetProgress, a.progress - step);

    if (next === a.targetProgress) {
      const shouldCommit = a.commit && a.targetProgress === 1;
      setAnim(null);
      if (shouldCommit) onMoveComplete?.(a.move);
    } else {
      setAnim({ ...a, progress: next });
    }
  });

  const { affectedAxis, affectedLayer, totalAngleSign } = useMemo(() => {
    if (!anim) return { affectedAxis: null as Axis | null, affectedLayer: 0, totalAngleSign: 1 };
    const face = anim.move[0] as Face;
    const prime = anim.move.includes("'");
    const double = anim.move.includes('2');
    const axis = AXIS[face];
    const layer = LAYER[face];
    let dir = layer === 1 ? -1 : 1;
    if (prime) dir = -dir;
    return { affectedAxis: axis, affectedLayer: layer, totalAngleSign: dir * (double ? 2 : 1) };
  }, [anim]);

  useEffect(() => {
    if (!rotatingGroupRef.current || !affectedAxis || !anim) return;
    const angle = totalAngleSign * (Math.PI / 2) * anim.progress;
    rotatingGroupRef.current.rotation.set(0, 0, 0);
    rotatingGroupRef.current.rotation[affectedAxis] = angle;
  }, [anim, affectedAxis, totalAngleSign]);

  const isAffected = useCallback(
    (x: number, y: number, z: number) => {
      if (!affectedAxis) return false;
      const coord = { x, y, z }[affectedAxis];
      return coord === affectedLayer;
    },
    [affectedAxis, affectedLayer]
  );

  // --- Manual drag-to-turn (mouse + touch, via the Pointer Events API) ---

  const toPx = (clientX: number, clientY: number): Vec2 => {
    const rect = gl.domElement.getBoundingClientRect();
    return { x: clientX - rect.left, y: -(clientY - rect.top) }; // y flipped: up positive, matching dragMath
  };

  const handleCubiePointerDown = (
    e: ThreeEvent<PointerEvent>,
    cubiePos: [number, number, number],
    face: Face
  ) => {
    if (animRef.current) return; // don't start a manual drag mid-animation
    const [x, y, z] = cubiePos;
    const normalAxis = AXIS[face];
    // Center cubie of this face: both candidate axes would be middle-slice
    // (not representable as a single face move) — let the event fall
    // through so OrbitControls handles it as a camera drag instead.
    const others = (['x', 'y', 'z'] as const).filter((a) => a !== normalAxis);
    const coordOf = { x, y, z };
    const validCandidates: DragCandidate[] = others
      .filter((a) => coordOf[a] !== 0)
      .map((axis) => ({ axis, layer: coordOf[axis] }));
    if (validCandidates.length === 0) return;

    // On mobile, a one-finger drag on empty background is how OrbitControls
    // orbits the camera; a one-finger drag starting ON a cubie must be
    // claimed here instead, or the browser's own touch handling (scroll,
    // pull-to-refresh, pinch-zoom) can also intercept it. Both matter:
    // stopPropagation keeps three.js/OrbitControls from also reacting;
    // preventDefault keeps the browser's native touch gestures from firing.
    e.stopPropagation();
    e.nativeEvent.preventDefault?.();
    gl.domElement.setPointerCapture?.(e.pointerId);
    if (orbitRef.current) orbitRef.current.enabled = false;

    lockThresholdRef.current = lockThresholdPx(e.nativeEvent.pointerType || 'mouse');
    dragStartRef.current = toPx(e.clientX, e.clientY);
    dragCandidateRef.current = { cubiePos, face };
    dragLockRef.current = null; // not locked yet — waits for threshold crossing
    pendingCandidatesRef.current = validCandidates;
    pendingCubieWorldPos.current = new THREE.Vector3(x, y, z);
  };

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      e.preventDefault(); // stop the page from scrolling under an active cubie drag
      const current = toPx(e.clientX, e.clientY);
      const dragPx = { x: current.x - dragStartRef.current.x, y: current.y - dragStartRef.current.y };
      const dragDist = Math.hypot(dragPx.x, dragPx.y);

      if (!dragLockRef.current) {
        if (dragDist < lockThresholdRef.current) return;
        const worldPos = pendingCubieWorldPos.current!;
        const face = dragCandidateRef.current!.face;
        const choice = chooseDragAxis({
          camera,
          viewport: size,
          cubiePos: worldPos,
          faceNormal: unitVector(AXIS[face], LAYER[face]),
          candidates: pendingCandidatesRef.current,
          dragPx,
        });
        if (!choice) return;
        dragLockRef.current = {
          axis: choice.axis,
          layer: choice.layer,
          move: faceFromAxisLayer(choice.axis, choice.layer), // "plain" move; prime derived from sign at commit
          tangentDirPx: choice.tangentDirPx,
          quarterPx: quarterTurnPx(size),
        };
        // One re-render, exactly at lock-in: this is what moves the affected
        // cubies from the static group into the rotating group (which
        // `effectiveIsAffected` below decides by reading dragLockRef).
        // Everything after this is driven imperatively — no more re-renders
        // per pointermove, just direct rotation mutation for smooth 60fps drag.
        setDragTick((t) => t + 1);
      }

      const lock = dragLockRef.current;
      if (!lock) return;
      const clamped = dragProgress(dragPx, lock.tangentDirPx, lock.quarterPx);

      if (rotatingGroupRef.current) {
        const baseDir = lock.layer === 1 ? -1 : 1;
        const angle = baseDir * (Math.PI / 2) * clamped;
        rotatingGroupRef.current.rotation.set(0, 0, 0);
        rotatingGroupRef.current.rotation[lock.axis] = angle;
      }
      lastRawProgressRef.current = clamped;
    };

    const onPointerUp = () => {
      if (!dragStartRef.current) return;
      const lock = dragLockRef.current;
      dragStartRef.current = null;
      dragLockRef.current = null;
      pendingCandidatesRef.current = [];
      pendingCubieWorldPos.current = null;
      if (orbitRef.current) orbitRef.current.enabled = true;

      if (!lock) return; // never crossed lock-in threshold — treat as a plain tap, no-op

      const finalProgress = lastRawProgressRef.current;
      const commit = Math.abs(finalProgress) >= 0.5;
      // Sign must be preserved whether committing or cancelling: the settle
      // animation continues from the live-drag angle, and that angle's sign
      // came from finalProgress regardless of whether we're about to commit
      // or snap back to 0. Tying "prime" only to the commit case (an earlier
      // version of this code did that) causes a visible sign-flip/jump right
      // at release for any cancelled negative-direction drag.
      const isPrime = finalProgress < 0;
      const finalMove = (isPrime ? (lock.move + "'") : lock.move) as Move;

      setAnim({
        move: finalMove,
        progress: Math.abs(finalProgress),
        targetProgress: commit ? 1 : 0,
        commit,
      });
    };

    // These are attached with { passive: false } specifically so
    // preventDefault() above actually works — passive listeners (the
    // default for touch move handlers in modern browsers) silently ignore
    // preventDefault, which would let the page scroll under your finger
    // while dragging a cubie.
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp); // e.g. an incoming call interrupts the touch
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, size]);

  const effectiveIsAffected = (x: number, y: number, z: number) => {
    if (dragLockRef.current) {
      const { axis, layer } = dragLockRef.current;
      return { x, y, z }[axis] === layer;
    }
    return isAffected(x, y, z);
  };

  const staticCubies = positions.filter(([x, y, z]) => !effectiveIsAffected(x, y, z));
  const movingCubies = positions.filter(([x, y, z]) => effectiveIsAffected(x, y, z));

  // Keep the whole cube framed the same way regardless of aspect ratio — a
  // portrait phone needs the camera pulled back further than a wide desktop
  // window at the same field of view, or the cube clips at the edges.
  useEffect(() => {
    const aspect = size.width / size.height;
    const dist = fitDistance(CAMERA_FOV, aspect);
    const dir = camera.position.clone().normalize();
    camera.position.copy(dir.multiplyScalar(dist));
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <directionalLight position={[-5, -3, -5]} intensity={0.3} />
      <group>
        {staticCubies.map(([x, y, z]) => (
          <Cubie
            key={`${x},${y},${z}`}
            position={[x, y, z]}
            cubeState={cubeState}
            onCubiePointerDown={handleCubiePointerDown}
          />
        ))}
        <group ref={rotatingGroupRef}>
          {movingCubies.map(([x, y, z]) => (
            <Cubie
              key={`${x},${y},${z}`}
              position={[x, y, z]}
              cubeState={cubeState}
              onCubiePointerDown={handleCubiePointerDown}
            />
          ))}
        </group>
      </group>
      {/* enableDamping smooths one-finger orbit and pinch-zoom on touch,
          where input is naturally less steady than a mouse. */}
      <OrbitControls
        ref={orbitRef}
        enablePan={false}
        enableDamping
        dampingFactor={0.15}
        minDistance={5}
        maxDistance={12}
      />
    </>
  );
}

interface CubeCanvasProps {
  cubeState: CubeState;
  pendingMove: Move | null;
  onMoveComplete?: (move: Move) => void;
}

export function CubeCanvas({ cubeState, pendingMove, onMoveComplete }: CubeCanvasProps) {
  return (
    <Canvas
      camera={{ position: [4, 4, 5], fov: CAMERA_FOV }}
      // touch-action: none hands ALL touch gesture handling on the canvas to
      // JS (our drag code + OrbitControls' own pinch/pan/rotate logic).
      // Without it, the browser's native scroll/pinch-zoom/pull-to-refresh
      // handling competes with three.js for the same touches — the classic
      // symptom is the page scrolling out from under a cube drag, or a
      // two-finger pinch zooming the whole page instead of the camera.
      style={{ width: '100%', height: '100%', touchAction: 'none' }}
    >
      <CubeScene cubeState={cubeState} pendingMove={pendingMove} onMoveComplete={onMoveComplete} />
    </Canvas>
  );
}
