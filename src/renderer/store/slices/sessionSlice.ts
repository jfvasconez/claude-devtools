/**
 * Session slice - manages session list state and pagination.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { Session, SessionSortMode } from '@renderer/types/data';
import type { TerminalStateChangeEvent } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:session');

/**
 * Tracks the latest in-place refresh generation per project.
 * Used to guarantee last-write-wins under rapid file change events.
 */
const projectRefreshGeneration = new Map<string, number>();

// =============================================================================
// Slice Interface
// =============================================================================

export interface SessionSlice {
  // State
  sessions: Session[];
  selectedSessionId: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  // Pagination state
  sessionsCursor: string | null;
  sessionsHasMore: boolean;
  sessionsTotalCount: number;
  sessionsLoadingMore: boolean;
  // Pinned sessions
  pinnedSessionIds: string[];
  // Hidden sessions
  hiddenSessionIds: string[];
  showHiddenSessions: boolean;
  // Multi-select
  sidebarSelectedSessionIds: string[];
  sidebarMultiSelectActive: boolean;
  // Sort mode
  sessionSortMode: SessionSortMode;

  // Actions
  fetchSessions: (projectId: string) => Promise<void>;
  fetchSessionsInitial: (projectId: string) => Promise<void>;
  fetchSessionsMore: () => Promise<void>;
  resetSessionsPagination: () => void;
  selectSession: (id: string) => void;
  clearSelection: () => void;
  /** Refresh sessions list without loading states - for real-time updates */
  refreshSessionsInPlace: (projectId: string) => Promise<void>;
  /**
   * Patch a session's live terminal state in place (wezterm hook), with no
   * refetch. Updates the sidebar list and every tab whose session detail shows
   * that session, so the chat pane's live indicator tracks the terminal.
   */
  applyTerminalStateChange: (event: TerminalStateChangeEvent) => void;
  /** Toggle pin/unpin for a session */
  togglePinSession: (sessionId: string) => Promise<void>;
  /** Load pinned sessions from config for current project */
  loadPinnedSessions: () => Promise<void>;
  /** Set session sort mode */
  setSessionSortMode: (mode: SessionSortMode) => void;
  /** Toggle hide/unhide for a session */
  toggleHideSession: (sessionId: string) => Promise<void>;
  /** Bulk hide sessions */
  hideMultipleSessions: (sessionIds: string[]) => Promise<void>;
  /** Bulk unhide sessions */
  unhideMultipleSessions: (sessionIds: string[]) => Promise<void>;
  /** Load hidden sessions from config for current project */
  loadHiddenSessions: () => Promise<void>;
  /** Toggle showing hidden sessions in sidebar */
  toggleShowHiddenSessions: () => void;
  /** Toggle one session's checkbox in sidebar multi-select */
  toggleSidebarSessionSelection: (sessionId: string) => void;
  /** Clear all selections and exit multi-select mode */
  clearSidebarSelection: () => void;
  /** Enter/exit selection mode */
  toggleSidebarMultiSelect: () => void;
  /** Bulk pin for multi-select */
  pinMultipleSessions: (sessionIds: string[]) => Promise<void>;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  // Initial state
  sessions: [],
  selectedSessionId: null,
  sessionsLoading: false,
  sessionsError: null,
  // Pagination state
  sessionsCursor: null,
  sessionsHasMore: false,
  sessionsTotalCount: 0,
  sessionsLoadingMore: false,
  // Pinned sessions
  pinnedSessionIds: [],
  // Hidden sessions
  hiddenSessionIds: [],
  showHiddenSessions: false,
  // Multi-select
  sidebarSelectedSessionIds: [],
  sidebarMultiSelectActive: false,
  // Sort mode
  sessionSortMode: 'recent' as SessionSortMode,

  // Fetch sessions for a specific project (legacy - not paginated)
  fetchSessions: async (projectId: string) => {
    set({ sessionsLoading: true, sessionsError: null });
    try {
      const sessions = await api.getSessions(projectId);
      // Sort by max of updatedAt/createdAt (descending)
      const sorted = [...sessions].sort(
        (a, b) =>
          Math.max(b.updatedAt ?? b.createdAt, b.createdAt) -
          Math.max(a.updatedAt ?? a.createdAt, a.createdAt)
      );
      set({ sessions: sorted, sessionsLoading: false });
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch sessions',
        sessionsLoading: false,
      });
    }
  },

  // Fetch initial page of sessions (paginated)
  fetchSessionsInitial: async (projectId: string) => {
    set({
      sessionsLoading: true,
      sessionsError: null,
      sessions: [],
      sessionsCursor: null,
      sessionsHasMore: false,
      sessionsTotalCount: 0,
    });
    try {
      const result = await api.getSessionsPaginated(projectId, null, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      set({
        sessions: result.sessions,
        sessionsCursor: result.nextCursor,
        sessionsHasMore: result.hasMore,
        sessionsTotalCount: result.totalCount,
        sessionsLoading: false,
      });

      const cacheProjectId = get().selectedProjectId;
      if (cacheProjectId) {
        get()._sessionCache.set(cacheProjectId, {
          sessions: result.sessions,
          cursor: result.nextCursor,
          hasMore: result.hasMore,
          totalCount: result.totalCount,
          timestamp: Date.now(),
        });
      }

      // Load pinned and hidden sessions after fetching session list
      void get().loadPinnedSessions();
      void get().loadHiddenSessions();
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch sessions',
        sessionsLoading: false,
      });
    }
  },

  // Fetch more sessions (next page)
  fetchSessionsMore: async () => {
    const state = get();
    const { selectedProjectId, sessionsCursor, sessionsHasMore, sessionsLoadingMore } = state;

    // Guard: don't fetch if already loading, no more pages, or no project
    if (!selectedProjectId || !sessionsHasMore || sessionsLoadingMore || !sessionsCursor) {
      return;
    }

    set({ sessionsLoadingMore: true });
    try {
      const result = await api.getSessionsPaginated(selectedProjectId, sessionsCursor, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      const existingIds = new Set(get().sessions.map((s) => s.id));
      const newSessions = result.sessions.filter((s) => !existingIds.has(s.id));
      set((prevState) => {
        // Deduplicate: pinned sessions fetched earlier may appear in paginated results.
        const nextSessions = [...prevState.sessions, ...newSessions];
        const inferredTotalLowerBound = nextSessions.length + (result.hasMore ? 1 : 0);
        const stableTotalCount = Math.max(
          prevState.sessionsTotalCount,
          result.totalCount,
          inferredTotalLowerBound
        );
        return {
          sessions: nextSessions,
          sessionsCursor: result.nextCursor,
          sessionsHasMore: result.hasMore,
          sessionsTotalCount: stableTotalCount,
          sessionsLoadingMore: false,
        };
      });
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch more sessions',
        sessionsLoadingMore: false,
      });
    }
  },

  // Reset pagination state
  resetSessionsPagination: () => {
    set({
      sessions: [],
      sessionsCursor: null,
      sessionsHasMore: false,
      sessionsTotalCount: 0,
      sessionsLoadingMore: false,
      sessionsError: null,
    });
  },

  // Select a session and fetch its detail
  selectSession: (id: string) => {
    set({
      selectedSessionId: id,
      sessionDetail: null,
      sessionContextStats: null,
      sessionDetailError: null,
    });

    // Fetch detail for this session, passing the active tabId for per-tab data
    const state = get();
    const projectId = state.selectedProjectId;
    if (projectId) {
      const activeTabId = state.activeTabId ?? undefined;
      void state.fetchSessionDetail(projectId, id, activeTabId);
    } else {
      logger.warn('Cannot fetch session detail: no project selected');
    }
  },

  // Clear all selections
  clearSelection: () => {
    set({
      selectedProjectId: null,
      selectedSessionId: null,
      sessions: [],
      sessionDetail: null,
      sessionContextStats: null,
    });
  },

  // Refresh sessions list in place without loading states
  // Used for real-time updates when new sessions are added
  refreshSessionsInPlace: async (projectId: string) => {
    const currentState = get();

    // Only refresh if viewing this project
    if (currentState.selectedProjectId !== projectId) {
      return;
    }

    const generation = (projectRefreshGeneration.get(projectId) ?? 0) + 1;
    projectRefreshGeneration.set(projectId, generation);

    try {
      const result = await api.getSessionsPaginated(projectId, null, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });

      // Drop stale responses from older in-flight refreshes
      if (projectRefreshGeneration.get(projectId) !== generation) {
        return;
      }

      let mergedSessions: Session[] = [];
      set((prevState) => {
        // A transient scan failure surfaces as an empty page (ProjectScanner's
        // listSessionsPaginated catch). Never let that blank a populated list —
        // it renders as a bogus "No sessions found" empty state.
        if (result.sessions.length === 0 && prevState.sessions.length > 0) {
          mergedSessions = prevState.sessions;
          return {};
        }

        // MERGE, don't replace. This only refetches page 1, so replacing wholesale
        // truncated the list back to 20 whenever the user had scrolled further —
        // rows vanished, the "load more" row reappeared, the virtualizer auto-paged,
        // and the next file event did it all again. That loop is the sidebar jank.
        const fresh = new Map(result.sessions.map((s) => [s.id, s]));
        const updated = prevState.sessions.map((s) => fresh.get(s.id) ?? s);
        const known = new Set(prevState.sessions.map((s) => s.id));
        const added = result.sessions.filter((s) => !known.has(s.id));
        mergedSessions = added.length > 0 ? [...added, ...updated] : updated;

        // Only page 1 is loaded → adopt the fresh cursor. Deeper pages are loaded →
        // keep ours; the page-1 cursor would rewind pagination and re-arm the
        // "load more" row we just scrolled past.
        const onlyFirstPageLoaded = prevState.sessions.length <= result.sessions.length;

        return {
          sessions: mergedSessions,
          sessionsCursor: onlyFirstPageLoaded ? result.nextCursor : prevState.sessionsCursor,
          sessionsHasMore: onlyFirstPageLoaded ? result.hasMore : prevState.sessionsHasMore,
          // Monotonic, mirroring fetchSessionsMore — a page-1 count must never
          // shrink a total established by deeper pages.
          sessionsTotalCount: Math.max(
            prevState.sessionsTotalCount,
            result.totalCount,
            mergedSessions.length
          ),
        };
      });

      const latest = get();
      get()._sessionCache.set(projectId, {
        sessions: mergedSessions,
        cursor: latest.sessionsCursor,
        hasMore: latest.sessionsHasMore,
        totalCount: latest.sessionsTotalCount,
        timestamp: Date.now(),
      });

      // Pinned/hidden rows can live outside page 1; without this they were dropped
      // on every refresh since only fetchSessionsInitial re-loaded them.
      void get().loadPinnedSessions();
      void get().loadHiddenSessions();
    } catch (error) {
      logger.error('refreshSessionsInPlace error:', error);
    }
  },

  // Patch live terminal state in place — no refetch. See TerminalStateChangeEvent.
  applyTerminalStateChange: (event: TerminalStateChangeEvent) => {
    const { sessionId } = event;

    // Bail before touching the store when nothing here shows this session. These
    // fire on every prompt submit and tool call across ALL sessions, and any set()
    // re-runs every selector in the app.
    const snapshot = get();
    const known =
      snapshot.sessions.some((s) => s.id === sessionId) ||
      snapshot.sessionDetail?.session?.id === sessionId ||
      Object.values(snapshot.tabSessionData).some(
        (d) => d?.sessionDetail?.session?.id === sessionId
      );
    if (!known) {
      return;
    }

    set((state) => {
      const { state: terminalState } = event;

      const sessionIndex = state.sessions.findIndex((s) => s.id === sessionId);
      const sessions =
        sessionIndex === -1
          ? state.sessions
          : state.sessions.map((s, i) => (i === sessionIndex ? { ...s, terminalState } : s));

      // Patch every tab showing this session. The chat pane can't get this from a
      // refresh: getSessionDetail short-circuits on an unchanged JSONL fingerprint,
      // so terminalState there was frozen at load time.
      let tabSessionDataChanged = false;
      const tabSessionData: typeof state.tabSessionData = {};
      for (const [tabId, data] of Object.entries(state.tabSessionData)) {
        if (data?.sessionDetail?.session?.id === sessionId) {
          tabSessionDataChanged = true;
          tabSessionData[tabId] = {
            ...data,
            sessionDetail: {
              ...data.sessionDetail,
              session: { ...data.sessionDetail.session, terminalState },
            },
          };
        } else {
          tabSessionData[tabId] = data;
        }
      }

      const globalDetail = state.sessionDetail;
      const sessionDetail =
        globalDetail?.session?.id === sessionId
          ? {
              ...globalDetail,
              session: { ...globalDetail.session, terminalState },
            }
          : globalDetail;

      if (sessionIndex === -1 && !tabSessionDataChanged && sessionDetail === globalDetail) {
        return {};
      }

      return {
        sessions,
        sessionDetail,
        ...(tabSessionDataChanged ? { tabSessionData } : {}),
      };
    });
  },

  // Toggle pin/unpin for a session (optimistic update)
  togglePinSession: async (sessionId: string) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const isPinned = state.pinnedSessionIds.includes(sessionId);
    const previousPinnedIds = state.pinnedSessionIds;

    // Optimistic: update UI immediately
    if (isPinned) {
      set({ pinnedSessionIds: previousPinnedIds.filter((id) => id !== sessionId) });
    } else {
      set({ pinnedSessionIds: [sessionId, ...previousPinnedIds] });
    }

    try {
      if (isPinned) {
        await api.config.unpinSession(projectId, sessionId);
      } else {
        await api.config.pinSession(projectId, sessionId);
      }
    } catch (error) {
      // Rollback on failure
      set({ pinnedSessionIds: previousPinnedIds });
      logger.error('togglePinSession error:', error);
    }
  },

  // Load pinned sessions from config for current project
  // Fetches missing pinned session data that may be beyond the paginated page
  loadPinnedSessions: async () => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) {
      set({ pinnedSessionIds: [] });
      return;
    }

    try {
      const config = await api.config.get();
      const pins = config.sessions?.pinnedSessions?.[projectId] ?? [];
      const pinnedIds = pins.map((p) => p.sessionId);
      set({ pinnedSessionIds: pinnedIds });

      // Determine which pinned sessions are missing from the loaded sessions array
      const currentSessions = get().sessions;
      const loadedIds = new Set(currentSessions.map((s) => s.id));
      const missingIds = pinnedIds.filter((id) => !loadedIds.has(id));

      if (missingIds.length > 0) {
        const missingSessions = await api.getSessionsByIds(projectId, missingIds, {
          metadataLevel: 'light',
        });
        if (missingSessions.length > 0) {
          // Re-read sessions in case they changed during the async call
          const latestSessions = get().sessions;
          const latestIds = new Set(latestSessions.map((s) => s.id));
          const toAppend = missingSessions.filter((s) => !latestIds.has(s.id));
          if (toAppend.length > 0) {
            set({ sessions: [...latestSessions, ...toAppend] });
          }
        }
      }
    } catch (error) {
      logger.error('loadPinnedSessions error:', error);
      set({ pinnedSessionIds: [] });
    }
  },

  // Set session sort mode
  setSessionSortMode: (mode: SessionSortMode) => {
    set({ sessionSortMode: mode });
  },

  // Toggle hide/unhide for a session (optimistic update)
  toggleHideSession: async (sessionId: string) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const isHidden = state.hiddenSessionIds.includes(sessionId);
    const previousHiddenIds = state.hiddenSessionIds;

    // Optimistic: update UI immediately
    if (isHidden) {
      set({ hiddenSessionIds: previousHiddenIds.filter((id) => id !== sessionId) });
    } else {
      set({ hiddenSessionIds: [sessionId, ...previousHiddenIds] });
    }

    try {
      if (isHidden) {
        await api.config.unhideSession(projectId, sessionId);
      } else {
        await api.config.hideSession(projectId, sessionId);
      }
    } catch (error) {
      // Rollback on failure
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('toggleHideSession error:', error);
    }
  },

  // Bulk hide sessions
  hideMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousHiddenIds = state.hiddenSessionIds;
    const existingSet = new Set(previousHiddenIds);
    const newIds = sessionIds.filter((id) => !existingSet.has(id));

    // Optimistic update
    set({ hiddenSessionIds: [...newIds, ...previousHiddenIds] });

    try {
      await api.config.hideSessions(projectId, sessionIds);
    } catch (error) {
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('hideMultipleSessions error:', error);
    }
  },

  // Bulk unhide sessions
  unhideMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousHiddenIds = state.hiddenSessionIds;
    const toRemove = new Set(sessionIds);

    // Optimistic update
    set({ hiddenSessionIds: previousHiddenIds.filter((id) => !toRemove.has(id)) });

    try {
      await api.config.unhideSessions(projectId, sessionIds);
    } catch (error) {
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('unhideMultipleSessions error:', error);
    }
  },

  // Load hidden sessions from config for current project
  loadHiddenSessions: async () => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) {
      set({ hiddenSessionIds: [] });
      return;
    }

    try {
      const config = await api.config.get();
      const hidden = config.sessions?.hiddenSessions?.[projectId] ?? [];
      const hiddenIds = hidden.map((h) => h.sessionId);
      set({ hiddenSessionIds: hiddenIds });
    } catch (error) {
      logger.error('loadHiddenSessions error:', error);
      set({ hiddenSessionIds: [] });
    }
  },

  // Toggle showing hidden sessions in sidebar
  toggleShowHiddenSessions: () => {
    set((prev) => ({ showHiddenSessions: !prev.showHiddenSessions }));
  },

  // Toggle one session's checkbox in sidebar multi-select
  toggleSidebarSessionSelection: (sessionId: string) => {
    set((prev) => {
      const selected = prev.sidebarSelectedSessionIds;
      if (selected.includes(sessionId)) {
        return { sidebarSelectedSessionIds: selected.filter((id) => id !== sessionId) };
      }
      return {
        sidebarSelectedSessionIds: [...selected, sessionId],
        sidebarMultiSelectActive: true,
      };
    });
  },

  // Clear all selections and exit multi-select mode
  clearSidebarSelection: () => {
    set({ sidebarSelectedSessionIds: [], sidebarMultiSelectActive: false });
  },

  // Enter/exit selection mode
  toggleSidebarMultiSelect: () => {
    set((prev) => {
      if (prev.sidebarMultiSelectActive) {
        return { sidebarMultiSelectActive: false, sidebarSelectedSessionIds: [] };
      }
      return { sidebarMultiSelectActive: true };
    });
  },

  // Bulk pin for multi-select
  pinMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousPinnedIds = state.pinnedSessionIds;
    const existingSet = new Set(previousPinnedIds);
    const newIds = sessionIds.filter((id) => !existingSet.has(id));

    // Optimistic update
    set({ pinnedSessionIds: [...newIds, ...previousPinnedIds] });

    try {
      // Pin each session individually (no bulk pin IPC)
      await Promise.all(newIds.map((sessionId) => api.config.pinSession(projectId, sessionId)));
    } catch (error) {
      set({ pinnedSessionIds: previousPinnedIds });
      logger.error('pinMultipleSessions error:', error);
    }
  },
});
