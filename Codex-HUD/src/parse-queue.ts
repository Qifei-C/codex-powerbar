import type { HudSnapshot } from './types.js';
import { type ParserState, createParserState, parseIncremental, finalizeSnapshot } from './incremental-parser.js';

/**
 * Single-flight parse queue.
 *
 * Ensures only one parse+finalize runs at a time. If a new request arrives
 * while one is in progress, it is queued as a trailing update so no change
 * is dropped, but redundant concurrent parses are avoided.
 */
export interface ParseQueue {
  /** Request a parse. Returns the latest snapshot. */
  request(rolloutPath: string): Promise<HudSnapshot>;
  /** Get the parser state (for overview mode to read compactCount etc.). */
  getState(): ParserState | null;
}

export function createParseQueue(): ParseQueue {
  let state: ParserState | null = null;
  let running = false;
  let pending: { rolloutPath: string; resolve: (s: HudSnapshot) => void } | null = null;

  async function execute(rolloutPath: string): Promise<HudSnapshot> {
    // New file — reset state.
    if (!state || state.rolloutPath !== rolloutPath) {
      state = createParserState(rolloutPath);
    }

    parseIncremental(state);
    return finalizeSnapshot(state);
  }

  async function drain(): Promise<void> {
    while (pending) {
      const { rolloutPath, resolve } = pending;
      pending = null;
      const snapshot = await execute(rolloutPath);
      resolve(snapshot);
    }
    running = false;
  }

  return {
    async request(rolloutPath: string): Promise<HudSnapshot> {
      if (!running) {
        running = true;
        const snapshot = await execute(rolloutPath);
        void drain();
        return snapshot;
      }

      // Already running — queue as trailing update.
      return new Promise<HudSnapshot>((resolve) => {
        pending = { rolloutPath, resolve };
      });
    },

    getState(): ParserState | null {
      return state;
    },
  };
}
