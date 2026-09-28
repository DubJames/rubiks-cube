import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CubeCanvas } from './CubeRenderer';
import { applyMove, solvedCube, randomScramble } from './cubeLogic';
import type { CubeState, Move } from './cubeLogic';
import { ensureSolverReady, solve } from './solver';

// Moves animate one at a time: a queue holds moves not yet started, and
// `pendingMove` is the one currently animating. CubeState only updates when
// the renderer reports a move's animation finished (onMoveComplete) — this
// keeps "what's true" (CubeState) and "what's currently being shown" (the
// animation) from getting out of sync if moves are queued faster than they play.
export function CubeApp() {
  const [cubeState, setCubeState] = useState<CubeState>(solvedCube());
  const [pendingMove, setPendingMove] = useState<Move | null>(null);
  const [solverReady, setSolverReady] = useState(false);
  const [solving, setSolving] = useState(false);
  const queueRef = useRef<Move[]>([]);
  // Always solve from the state as of the click, not whatever it drifts to
  // while queued moves are still animating.
  const cubeStateRef = useRef(cubeState);
  cubeStateRef.current = cubeState;

  useEffect(() => {
    ensureSolverReady().then(() => setSolverReady(true));
  }, []);

  const playNextFromQueue = useCallback(() => {
    const next = queueRef.current.shift();
    if (next) setPendingMove(next);
  }, []);

  const queueMoves = useCallback(
    (moves: Move[]) => {
      queueRef.current.push(...moves);
      if (!pendingMove) playNextFromQueue();
    },
    [pendingMove, playNextFromQueue]
  );

  const handleMoveComplete = useCallback(
    (move: Move) => {
      setCubeState((s) => applyMove(s, move));
      setPendingMove(null);
      // Let the CubeState update flush before starting the next animation.
      requestAnimationFrame(playNextFromQueue);
    },
    [playNextFromQueue]
  );

  const handleScramble = () => queueMoves(randomScramble());
  const handleReset = () => {
    queueRef.current = [];
    setPendingMove(null);
    setCubeState(solvedCube());
  };
  const handleSolve = async () => {
    setSolving(true);
    try {
      const solution = await solve(cubeStateRef.current);
      queueMoves(solution);
    } finally {
      setSolving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CubeCanvas cubeState={cubeState} pendingMove={pendingMove} onMoveComplete={handleMoveComplete} />
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        <button style={buttonStyle} onClick={handleScramble}>Scramble</button>
        <button style={buttonStyle} onClick={handleReset}>Reset</button>
        <button style={buttonStyle} onClick={handleSolve} disabled={!solverReady || solving}>
          {!solverReady ? 'Preparing solver…' : solving ? 'Solving…' : 'Solve'}
        </button>
      </div>
    </div>
  );
}

// 44px is the standard comfortable minimum tap target size on iOS/Android —
// default unstyled <button> padding falls well short of that.
const buttonStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 16px',
  fontSize: 16,
};
