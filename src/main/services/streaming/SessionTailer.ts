/**
 * SessionTailer - streams newly-appended JSONL entries for currently-open sessions.
 *
 * The FileWatcher already detects per-file changes and emits `file-change`. That
 * event tells the renderer "something changed"; historically the renderer reacted by
 * re-fetching and re-parsing the WHOLE session file. SessionTailer makes updates truly
 * incremental: for a session the user currently has open (one with a registered
 * baseline byte-offset), it reads only the bytes appended since the last emission,
 * parses the complete lines, and emits a `session-append` delta.
 *
 * Baseline registration ties into `getSessionDetail`: when that route reads a session
 * file to establish the renderer's initial view, it calls `setBaseline(sessionId, path,
 * byteLength)` so streaming begins exactly where the initial load ended.
 *
 * Only baselined (open) sessions are tailed. Background sessions fall through to the
 * existing `file-change` flow, which keeps memory bounded (soft LRU cap) and avoids
 * streaming for sessions nobody is watching.
 */

import { type ChatHistoryEntry, type FileChangeEvent } from '@main/types';
import { createLogger } from '@shared/utils/logger';
import { EventEmitter } from 'events';

import type { FileSystemProvider } from '../infrastructure/FileSystemProvider';

const logger = createLogger('Service:SessionTailer');

/** Soft cap on tracked open sessions; oldest (LRU) is evicted past this. */
const MAX_TRACKED_SESSIONS = 8;

/**
 * Payload for the `session-append` SSE event.
 * Emitted only for baselined sessions on clean forward growth.
 */
export interface SessionAppendEvent {
  sessionId: string;
  /** Project id when known (state-file changes carry none — those are never tailed). */
  projectId?: string;
  /**
   * Raw parsed JSONL line objects (the direct `JSON.parse` of each complete appended
   * line), in file order. NOT run through the session parser — the renderer transforms
   * them the same way it transforms a full `getSessionDetail` payload.
   */
  entries: ChatHistoryEntry[];
  /**
   * Byte offset (complete-line boundary) this delta STARTS at. Equals the previous
   * `tailOffset` (or the `getSessionDetail` baseline for the first delta). The renderer
   * compares this against its expected offset to detect a gap/overlap and refetch.
   */
  baseOffset: number;
  /** Byte offset (complete-line boundary) AFTER this delta. The renderer's new baseline. */
  tailOffset: number;
}

/** Per-session tail state. */
interface TailState {
  path: string;
  projectId?: string;
  /** Total bytes read from the file so far (== last observed size we consumed to). */
  offset: number;
  /** Buffered incomplete trailing line (bytes read but not yet a complete line). */
  partial: string;
  /** Birthtime fingerprint to detect file replacement/rewrite (inode not exposed by provider). */
  birthtimeMs: number;
}

export class SessionTailer extends EventEmitter {
  /** Insertion-ordered map used as an LRU (most-recently-baselined last). */
  private readonly sessions = new Map<string, TailState>();
  private fsProvider: FileSystemProvider;

  constructor(fsProvider: FileSystemProvider) {
    super();
    this.fsProvider = fsProvider;
  }

  /**
   * Swaps the filesystem provider (e.g. on local <-> SSH context switch). Callers
   * should also `clear()` baselines, since offsets from one context don't apply to another.
   */
  setFileSystemProvider(provider: FileSystemProvider): void {
    this.fsProvider = provider;
  }

  /**
   * Registers (or refreshes) the streaming baseline for a session. Called from the
   * `getSessionDetail` path with the byte length that was read to build the initial
   * view, so the first `session-append` starts exactly where that load ended.
   */
  setBaseline(sessionId: string, filePath: string, byteLength: number, projectId?: string): void {
    // Re-insert to move to the MRU end of the LRU map.
    this.sessions.delete(sessionId);

    // stat is async; baseline just needs the offset. Birthtime is captured lazily on the
    // first change instead of blocking this call — a 0 sentinel means "not yet captured".
    this.sessions.set(sessionId, {
      path: filePath,
      projectId,
      offset: byteLength,
      partial: '',
      birthtimeMs: 0,
    });

    this.evictIfNeeded();
    logger.info(`SessionTailer: baseline set for ${sessionId} at offset ${byteLength}`);
  }

  /** Drops a session's tail state (e.g. on unlink or when the user closes it). */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Drops all tail state (e.g. on context switch). */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Processes a FileWatcher `file-change` event. For a baselined, non-subagent session
   * file that grew, emits a `session-append` delta. On truncation/rewrite it re-anchors
   * and emits nothing (the still-broadcast `file-change` is the renderer's reload signal).
   * Non-baselined sessions are ignored.
   */
  async handleFileChange(event: FileChangeEvent): Promise<void> {
    const { sessionId, isSubagent, type } = event;
    if (!sessionId || isSubagent) {
      return;
    }

    // Unlink: forget the session; the file-change already tells the renderer.
    if (type === 'unlink') {
      this.sessions.delete(sessionId);
      return;
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      // Not an open/baselined session — let the normal file-change flow handle it.
      return;
    }

    try {
      const stats = await this.fsProvider.stat(event.path);
      const size = stats.size;

      // Detect file replacement/rewrite via birthtime change (inode unavailable through
      // the provider). Also treat a shrink as truncation. Either way: re-anchor, no delta.
      const birthChanged =
        state.birthtimeMs !== 0 &&
        typeof stats.birthtimeMs === 'number' &&
        stats.birthtimeMs !== state.birthtimeMs;

      if (size < state.offset || birthChanged) {
        // Re-anchor to the current end so we don't spew the whole file as a delta in the
        // window before the renderer refetches (it will, off the broadcast file-change).
        state.offset = size;
        state.partial = '';
        state.birthtimeMs =
          typeof stats.birthtimeMs === 'number' ? stats.birthtimeMs : state.birthtimeMs;
        logger.info(`SessionTailer: truncation/rewrite on ${sessionId}; re-anchored at ${size}`);
        return;
      }

      // First change after baseline: capture the birthtime fingerprint.
      if (state.birthtimeMs === 0 && typeof stats.birthtimeMs === 'number') {
        state.birthtimeMs = stats.birthtimeMs;
      }

      if (size <= state.offset) {
        // No new bytes (e.g. a metadata-only touch).
        return;
      }

      const baseOffset = state.offset - Buffer.byteLength(state.partial, 'utf8');
      const { entries, partial } = await this.readAppended(event.path, state.offset, state.partial);

      state.offset = size;
      state.partial = partial;

      if (entries.length === 0) {
        // Only a partial (incomplete) line arrived; wait for it to complete.
        return;
      }

      const tailOffset = state.offset - Buffer.byteLength(state.partial, 'utf8');

      const payload: SessionAppendEvent = {
        sessionId,
        projectId: state.projectId ?? event.projectId,
        entries,
        baseOffset,
        tailOffset,
      };
      this.emit('session-append', payload);
      logger.info(
        `SessionTailer: ${entries.length} appended ${entries.length === 1 ? 'entry' : 'entries'} for ${sessionId} (${baseOffset}->${tailOffset})`
      );
    } catch (err) {
      logger.error(`SessionTailer: error tailing ${sessionId}:`, err);
    }
  }

  /**
   * Reads bytes [startOffset, EOF), prepends the buffered partial line, splits on '\n',
   * and JSON-parses each complete line. The trailing element (if the buffer didn't end in
   * a newline) becomes the new partial. Malformed/blank lines are skipped.
   */
  private async readAppended(
    filePath: string,
    startOffset: number,
    priorPartial: string
  ): Promise<{ entries: ChatHistoryEntry[]; partial: string }> {
    const stream = this.fsProvider.createReadStream(filePath, {
      start: startOffset,
      encoding: 'utf8',
    });

    let buffer = priorPartial;
    const entries: ChatHistoryEntry[] = [];

    for await (const chunk of stream) {
      buffer += chunk;
      const lines = buffer.split('\n');
      // Last element is an incomplete line (or '' if the chunk ended on a newline).
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
          continue;
        }
        try {
          entries.push(JSON.parse(line) as ChatHistoryEntry);
        } catch {
          // Malformed appended line; skip. A later full refetch recovers if needed.
        }
      }
    }

    return { entries, partial: buffer };
  }

  /** Evicts the least-recently-baselined session past the soft cap. */
  private evictIfNeeded(): void {
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sessions.delete(oldest);
    }
  }
}
