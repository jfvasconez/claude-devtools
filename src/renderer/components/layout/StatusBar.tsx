/**
 * StatusBar - Persistent, editor-style status bar pinned to the bottom of a
 * session pane. Mirrors the owner's Claude Code statusline for the currently-
 * viewed session:
 *
 *   Opus 4.8 (1M context)  ·  Context 47%  ·  Weekly 85% → Jul 23  ·  Session 79% → 1:39am
 *
 *   - model (friendly label derived from the session's assistant messages)
 *   - context-window consumption (%)
 *   - weekly + current-session usage limits (via useUsage → GET /api/usage)
 *   - live terminal-state dot for the current session (wezterm palette)
 *
 * Session detail comes from the per-tab store slice (no new fetching here);
 * usage is polled by the `useUsage` hook (30s).
 */

import React, { useMemo } from 'react';

import {
  COLOR_BORDER_SUBTLE,
  COLOR_SURFACE_RAISED,
  COLOR_TEXT_MUTED,
} from '@renderer/constants/cssVariables';
import { getTerminalVisual, type TerminalStateInfo } from '@renderer/constants/sessionStatus';
import { useUsage, type UsageWindow } from '@renderer/hooks/useUsage';
import { useStore } from '@renderer/store';
import { getModelColorClass, parseModelString } from '@shared/utils/modelParser';
import { useShallow } from 'zustand/react/shallow';

import type { ModelInfo } from '@shared/utils/modelParser';

/**
 * Nominal context-window size used to render the consumption percentage.
 * Matches the sidebar's ConsumptionBadge "high" heuristic (>150k ≈ 75% here);
 * kept local since the codebase has no single window-size constant.
 */
const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Derive the session's model from its assistant messages (last one wins),
 * returning both the parsed info and the raw id (needed to detect the 1M
 * context marker, which `parseModelString` drops).
 */
function useSessionModel(
  messages: ReadonlyArray<{ type: string; model?: string }> | undefined
): { info: ModelInfo | null; raw: string | null } {
  return useMemo(() => {
    if (!messages) return { info: null, raw: null };
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'assistant' && msg.model) {
        const info = parseModelString(msg.model);
        if (info) return { info, raw: msg.model };
      }
    }
    return { info: null, raw: null };
  }, [messages]);
}

/**
 * Map a raw model id + parsed info to a user-friendly label, e.g.
 * "claude-opus-4-8[1m]" → "Opus 4.8 (1M context)".
 * - Title-case the family (opus/sonnet/haiku/fable → Opus/…).
 * - Format the version as "<major>.<minor>" (or just "<major>").
 * - Append " (1M context)" when the raw id carries a 1m marker.
 */
function friendlyModelLabel(raw: string, info: ModelInfo | null): string {
  const family = info?.family ?? '';
  const titled = family ? family.charAt(0).toUpperCase() + family.slice(1) : raw;
  const version = info
    ? info.minorVersion != null
      ? `${info.majorVersion}.${info.minorVersion}`
      : `${info.majorVersion}`
    : '';
  const base = version ? `${titled} ${version}` : titled;
  return /1m/i.test(raw) ? `${base} (1M context)` : base;
}

/** Weekly reset → "Jul 23" (local). */
function formatWeeklyReset(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Session reset → "1:39am" (local, lowercase meridiem). */
function formatSessionReset(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const meridiem = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')}${meridiem}`;
}

interface StatusBarProps {
  /** Tab id whose session detail should be shown. */
  tabId: string;
}

const Separator = (): React.JSX.Element => (
  <span aria-hidden className="shrink-0" style={{ color: COLOR_BORDER_SUBTLE }}>
    ·
  </span>
);

/** A "<label> <util>% → <reset>" usage segment; renders null when window absent. */
const UsageSegment = ({
  label,
  window,
  formatReset,
}: Readonly<{
  label: string;
  window: UsageWindow | null | undefined;
  formatReset: (iso: string) => string;
}>): React.JSX.Element | null => {
  if (!window) return null;
  const reset = formatReset(window.resets_at);
  return (
    <span className="shrink-0 tabular-nums" style={{ color: COLOR_TEXT_MUTED }}>
      {label} {Math.round(window.utilization)}%{reset && <span aria-hidden> → {reset}</span>}
    </span>
  );
};

export const StatusBar = ({ tabId }: Readonly<StatusBarProps>): React.JSX.Element | null => {
  // Per-tab session detail, falling back to the global slice (mirrors SessionTabContent).
  const sessionDetail = useStore(
    useShallow((s) => s.tabSessionData[tabId]?.sessionDetail ?? s.sessionDetail)
  );

  const { info: model, raw: rawModel } = useSessionModel(sessionDetail?.messages);
  const usage = useUsage();

  // No session loaded → render nothing (cleaner than an empty muted bar).
  if (!sessionDetail) return null;

  const { session } = sessionDetail;

  const contextConsumption = session.contextConsumption ?? 0;
  const contextPercent =
    contextConsumption > 0
      ? Math.min((contextConsumption / CONTEXT_WINDOW_TOKENS) * 100, 100)
      : 0;
  const contextIsHigh = contextConsumption > 150_000;

  // Live status: TRUE terminal state (wezterm hook), colored only when live.
  const liveVisual = getTerminalVisual(
    (session as { terminalState?: TerminalStateInfo }).terminalState
  );

  const modelLabel = rawModel ? friendlyModelLabel(rawModel, model) : null;

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 overflow-hidden px-3 font-mono text-sm"
      style={{
        backgroundColor: COLOR_SURFACE_RAISED,
        borderTop: `1px solid ${COLOR_BORDER_SUBTLE}`,
        color: COLOR_TEXT_MUTED,
      }}
      title={`Session ${session.id}`}
    >
      {/* Model */}
      {modelLabel && (
        <span className={`shrink-0 ${model ? getModelColorClass(model.family) : ''}`}>
          {modelLabel}
        </span>
      )}

      {/* Context window consumption */}
      {contextConsumption > 0 && (
        <>
          {modelLabel && <Separator />}
          <span
            className="shrink-0 tabular-nums"
            style={{ color: contextIsHigh ? 'rgb(251, 191, 36)' : COLOR_TEXT_MUTED }}
            title="Context consumed (compaction-aware) vs 200k window"
          >
            Context {contextPercent.toFixed(0)}%
          </span>
        </>
      )}

      {/* Weekly usage limit */}
      {usage?.weekly && (
        <>
          <Separator />
          <UsageSegment label="Weekly" window={usage.weekly} formatReset={formatWeeklyReset} />
        </>
      )}

      {/* Current-session usage limit */}
      {usage?.session && (
        <>
          <Separator />
          <UsageSegment label="Session" window={usage.session} formatReset={formatSessionReset} />
        </>
      )}

      {/* Spacer pushes live status to the right edge */}
      <div className="ml-auto" />

      {/* Live terminal status */}
      <span className="flex shrink-0 items-center gap-1.5">
        {liveVisual ? (
          <>
            <span
              className={`inline-block size-2 rounded-full ${liveVisual.pulse ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: liveVisual.color }}
              aria-hidden
            />
            <span style={{ color: liveVisual.color }}>{liveVisual.label}</span>
          </>
        ) : (
          <span style={{ color: COLOR_TEXT_MUTED }}>Idle</span>
        )}
      </span>
    </div>
  );
};
