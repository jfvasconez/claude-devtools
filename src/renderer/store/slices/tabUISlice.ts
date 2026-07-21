/**
 * Tab UI slice - manages per-tab UI state (expansion states, scroll positions, etc.)
 *
 * This slice provides COMPLETE isolation of UI state between tabs. Each tab has its
 * own independent state for:
 * - AI group expansion (collapsed/expanded)
 * - Display item expansion within AI groups
 * - Subagent trace expansion
 * - Context panel visibility
 * - Scroll position
 *
 * The state is keyed by tabId, so opening the same session in two tabs gives each
 * tab its own independent UI state.
 */

import type { AppState } from '../types';
import type { StateCreator } from 'zustand';

// =============================================================================
// Types
// =============================================================================

/**
 * UI state for a single tab.
 * All values are optional - defaults are applied when reading.
 */
export interface TabUIState {
  /**
   * Which AI groups are COLLAPSED (by aiGroupId).
   * Default presentation is expanded, so this set tracks the exceptions the user
   * manually collapsed. Empty = every group expanded.
   */
  collapsedAIGroupIds: Set<string>;

  /**
   * Which display items within AI groups are COLLAPSED: Map<aiGroupId, Set<itemId>>.
   * Default presentation is expanded; this tracks manual collapses.
   */
  collapsedDisplayItemIds: Map<string, Set<string>>;

  /** Which subagent traces are manually expanded (by subagentId) */
  expandedSubagentTraceIds: Set<string>;

  /**
   * Which per-type filter chips are HIDDEN (by FilterType string).
   * Empty = all item types shown. Stored as strings to avoid coupling the store
   * to the renderer-local FilterType union.
   */
  hiddenFilterTypes: Set<string>;

  /** Whether the context panel is visible */
  showContextPanel: boolean;

  /** Selected context phase for filtering (null = current/latest phase) */
  selectedContextPhase: number | null;

  /** Saved scroll position for restoring when switching back to this tab */
  savedScrollTop?: number;
}

/**
 * Creates a default/empty TabUIState.
 */
function createDefaultTabUIState(): TabUIState {
  return {
    collapsedAIGroupIds: new Set(),
    collapsedDisplayItemIds: new Map(),
    expandedSubagentTraceIds: new Set(),
    hiddenFilterTypes: new Set(),
    showContextPanel: false,
    selectedContextPhase: null,
    savedScrollTop: undefined,
  };
}

// =============================================================================
// Slice Interface
// =============================================================================

export interface TabUISlice {
  /** Per-tab UI states: Map<tabId, TabUIState> */
  tabUIStates: Map<string, TabUIState>;

  // Initialization & cleanup
  /** Initialize UI state for a new tab */
  initTabUIState: (tabId: string) => void;
  /** Clean up UI state when a tab is closed */
  cleanupTabUIState: (tabId: string) => void;

  // AI Group expansion (per-tab)
  /** Toggle AI group expansion for a specific tab */
  toggleAIGroupExpansionForTab: (tabId: string, aiGroupId: string) => void;
  /** Check if AI group is expanded for a specific tab */
  isAIGroupExpandedForTab: (tabId: string, aiGroupId: string) => boolean;
  /** Expand AI group for a specific tab (for auto-expand scenarios) */
  expandAIGroupForTab: (tabId: string, aiGroupId: string) => void;

  // Display item expansion (per-tab)
  /** Toggle display item expansion within an AI group for a specific tab */
  toggleDisplayItemExpansionForTab: (tabId: string, aiGroupId: string, itemId: string) => void;
  /** Get COLLAPSED display item IDs for an AI group in a specific tab (default: all expanded) */
  getCollapsedDisplayItemIdsForTab: (tabId: string, aiGroupId: string) => Set<string>;
  /** Ensure a display item is expanded for a specific tab (for auto-expand scenarios) */
  expandDisplayItemForTab: (tabId: string, aiGroupId: string, itemId: string) => void;

  // Per-type filter (per-tab)
  /** Toggle a filter type's visibility for a specific tab */
  toggleFilterTypeForTab: (tabId: string, filterType: string) => void;
  /** Replace the hidden filter-type set for a specific tab */
  setHiddenFilterTypesForTab: (tabId: string, hidden: Set<string>) => void;
  /** Get the hidden filter-type set for a specific tab */
  getHiddenFilterTypesForTab: (tabId: string) => Set<string>;

  // Subagent trace expansion (per-tab)
  /** Toggle subagent trace expansion for a specific tab */
  toggleSubagentTraceExpansionForTab: (tabId: string, subagentId: string) => void;
  /** Expand subagent trace for a specific tab (no-op if already expanded) */
  expandSubagentTraceForTab: (tabId: string, subagentId: string) => void;
  /** Check if subagent trace is expanded for a specific tab */
  isSubagentTraceExpandedForTab: (tabId: string, subagentId: string) => boolean;

  // Context panel (per-tab)
  /** Set context panel visibility for a specific tab */
  setContextPanelVisibleForTab: (tabId: string, visible: boolean) => void;
  /** Get context panel visibility for a specific tab */
  isContextPanelVisibleForTab: (tabId: string) => boolean;

  // Context phase selection (per-tab)
  /** Set the selected context phase for a specific tab */
  setSelectedContextPhaseForTab: (tabId: string, phase: number | null) => void;

  // Scroll position (per-tab)
  /** Save scroll position for a specific tab */
  saveScrollPositionForTab: (tabId: string, scrollTop: number) => void;
  /** Get saved scroll position for a specific tab */
  getScrollPositionForTab: (tabId: string) => number | undefined;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createTabUISlice: StateCreator<AppState, [], [], TabUISlice> = (set, get) => ({
  tabUIStates: new Map<string, TabUIState>(),

  // ==========================================================================
  // Initialization & Cleanup
  // ==========================================================================

  initTabUIState: (tabId: string) => {
    const state = get();
    if (state.tabUIStates.has(tabId)) return; // Already initialized

    const newMap = new Map(state.tabUIStates);
    newMap.set(tabId, createDefaultTabUIState());
    set({ tabUIStates: newMap });
  },

  cleanupTabUIState: (tabId: string) => {
    const state = get();
    if (!state.tabUIStates.has(tabId)) return;

    const newMap = new Map(state.tabUIStates);
    newMap.delete(tabId);
    set({ tabUIStates: newMap });
  },

  // ==========================================================================
  // AI Group Expansion
  // ==========================================================================

  toggleAIGroupExpansionForTab: (tabId: string, aiGroupId: string) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    // Default is expanded, so presence in the set means "collapsed". Toggling flips it.
    const newCollapsedIds = new Set(tabState.collapsedAIGroupIds);
    if (newCollapsedIds.has(aiGroupId)) {
      newCollapsedIds.delete(aiGroupId);
    } else {
      newCollapsedIds.add(aiGroupId);
    }

    newMap.set(tabId, { ...tabState, collapsedAIGroupIds: newCollapsedIds });
    set({ tabUIStates: newMap });
  },

  isAIGroupExpandedForTab: (tabId: string, aiGroupId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    // Expanded by default; only collapsed when explicitly in the set.
    return !(tabState?.collapsedAIGroupIds.has(aiGroupId) ?? false);
  },

  expandAIGroupForTab: (tabId: string, aiGroupId: string) => {
    const state = get();
    const tabState = state.tabUIStates.get(tabId);
    // Ensure expanded = remove from the collapsed set (no-op if not collapsed).
    if (!tabState || !tabState.collapsedAIGroupIds.has(aiGroupId)) return;

    const newMap = new Map(state.tabUIStates);
    const newCollapsedIds = new Set(tabState.collapsedAIGroupIds);
    newCollapsedIds.delete(aiGroupId);

    newMap.set(tabId, { ...tabState, collapsedAIGroupIds: newCollapsedIds });
    set({ tabUIStates: newMap });
  },

  // ==========================================================================
  // Display Item Expansion
  // ==========================================================================

  toggleDisplayItemExpansionForTab: (tabId: string, aiGroupId: string, itemId: string) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    // Default expanded → presence means "collapsed". Toggle flips membership.
    const newDisplayItemMap = new Map(tabState.collapsedDisplayItemIds);
    const currentSet = newDisplayItemMap.get(aiGroupId) ?? new Set<string>();
    const newSet = new Set(currentSet);

    if (newSet.has(itemId)) {
      newSet.delete(itemId);
    } else {
      newSet.add(itemId);
    }

    newDisplayItemMap.set(aiGroupId, newSet);
    newMap.set(tabId, { ...tabState, collapsedDisplayItemIds: newDisplayItemMap });
    set({ tabUIStates: newMap });
  },

  getCollapsedDisplayItemIdsForTab: (tabId: string, aiGroupId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    return tabState?.collapsedDisplayItemIds.get(aiGroupId) ?? new Set<string>();
  },

  expandDisplayItemForTab: (tabId: string, aiGroupId: string, itemId: string) => {
    const state = get();
    const tabState = state.tabUIStates.get(tabId);
    if (!tabState) return;
    const currentSet = tabState.collapsedDisplayItemIds.get(aiGroupId);
    // Ensure expanded = remove from the collapsed set (no-op if not collapsed).
    if (!currentSet?.has(itemId)) return;

    const newMap = new Map(state.tabUIStates);
    const newDisplayItemMap = new Map(tabState.collapsedDisplayItemIds);
    const newSet = new Set(currentSet);
    newSet.delete(itemId);
    newDisplayItemMap.set(aiGroupId, newSet);

    newMap.set(tabId, { ...tabState, collapsedDisplayItemIds: newDisplayItemMap });
    set({ tabUIStates: newMap });
  },

  // ==========================================================================
  // Per-type Filter
  // ==========================================================================

  toggleFilterTypeForTab: (tabId: string, filterType: string) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    const newHidden = new Set(tabState.hiddenFilterTypes);
    if (newHidden.has(filterType)) {
      newHidden.delete(filterType);
    } else {
      newHidden.add(filterType);
    }

    newMap.set(tabId, { ...tabState, hiddenFilterTypes: newHidden });
    set({ tabUIStates: newMap });
  },

  setHiddenFilterTypesForTab: (tabId: string, hidden: Set<string>) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();
    newMap.set(tabId, { ...tabState, hiddenFilterTypes: new Set(hidden) });
    set({ tabUIStates: newMap });
  },

  getHiddenFilterTypesForTab: (tabId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    return tabState?.hiddenFilterTypes ?? new Set<string>();
  },

  // ==========================================================================
  // Subagent Trace Expansion
  // ==========================================================================

  toggleSubagentTraceExpansionForTab: (tabId: string, subagentId: string) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    const newExpandedIds = new Set(tabState.expandedSubagentTraceIds);
    if (newExpandedIds.has(subagentId)) {
      newExpandedIds.delete(subagentId);
    } else {
      newExpandedIds.add(subagentId);
    }

    newMap.set(tabId, { ...tabState, expandedSubagentTraceIds: newExpandedIds });
    set({ tabUIStates: newMap });
  },

  expandSubagentTraceForTab: (tabId: string, subagentId: string) => {
    const state = get();
    const tabState = state.tabUIStates.get(tabId) ?? createDefaultTabUIState();

    // No-op if already expanded
    if (tabState.expandedSubagentTraceIds.has(subagentId)) return;

    const newExpandedIds = new Set(tabState.expandedSubagentTraceIds);
    newExpandedIds.add(subagentId);

    const newMap = new Map(state.tabUIStates);
    newMap.set(tabId, { ...tabState, expandedSubagentTraceIds: newExpandedIds });
    set({ tabUIStates: newMap });
  },

  isSubagentTraceExpandedForTab: (tabId: string, subagentId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    return tabState?.expandedSubagentTraceIds.has(subagentId) ?? false;
  },

  // ==========================================================================
  // Context Panel
  // ==========================================================================

  setContextPanelVisibleForTab: (tabId: string, visible: boolean) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    newMap.set(tabId, { ...tabState, showContextPanel: visible });
    set({ tabUIStates: newMap });
  },

  isContextPanelVisibleForTab: (tabId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    return tabState?.showContextPanel ?? false;
  },

  // ==========================================================================
  // Context Phase Selection
  // ==========================================================================

  setSelectedContextPhaseForTab: (tabId: string, phase: number | null) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();
    newMap.set(tabId, { ...tabState, selectedContextPhase: phase });
    set({ tabUIStates: newMap });
  },

  // ==========================================================================
  // Scroll Position
  // ==========================================================================

  saveScrollPositionForTab: (tabId: string, scrollTop: number) => {
    const state = get();
    const newMap = new Map(state.tabUIStates);
    const tabState = newMap.get(tabId) ?? createDefaultTabUIState();

    newMap.set(tabId, { ...tabState, savedScrollTop: scrollTop });
    set({ tabUIStates: newMap });
  },

  getScrollPositionForTab: (tabId: string) => {
    const tabState = get().tabUIStates.get(tabId);
    return tabState?.savedScrollTop;
  },
});
