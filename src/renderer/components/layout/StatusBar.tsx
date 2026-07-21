/**
 * StatusBar - Persistent, editor-style status bar pinned to the bottom of a
 * session pane. Composes existing selectors/data (no new data plumbing) into a
 * single compact row for the currently-viewed session:
 *   - short session id
 *   - model (derived from the session's assistant messages)
 *   - context-window consumption (tokens + % of window)
 *   - session token total (via the existing MetricsPill)
 *   - live/ongoing status (wezterm palette via getLiveStatusVisual)
 *
 * Data comes from the per-tab session detail already in the store; this
 * component adds no fetching and no timers (static values that update when the
 * store updates).
 */

import React, { useMemo } from 'react';

import {
  COLOR_BORDER_SUBTLE,
  COLOR_SURFACE_RAISED,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
} from '@renderer/constants/cssVariables';
import { getLiveStatusVisual, resolveSessionStatus } from '@renderer/constants/sessionStatus';
import { useStore } from '@renderer/store';
import { getModelColorClass, parseModelString } from '@shared/utils/modelParser';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { useShallow } from 'zustand/react/shallow';

import { MetricsPill } from '../chat/items/MetricsPill';

import type { ModelInfo } from '@shared/utils/modelParser';

/**
 * Nominal context-window size used to render the consumption percentage.
 * Matches the sidebar's ConsumptionBadge "high" heuristic (>150k ≈ 75% here);
 * kept local since the codebase has no single window-size constant.
 */
const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Derive the session's model from its assistant messages (last one wins).
 * The renderer surfaces model per-AI-group (aiGroupEnhancer.mainModel); for a
 * session-wide bar we scan messages directly so no new backend field is needed.
 */
function useSessionModel(
  messages: ReadonlyArray<{ type: string; model?: string }> | undefined
): ModelInfo | null {
  return useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'assistant' && msg.model) {
        const info = parseModelString(msg.model);
        if (info) return info;
      }
    }
    return null;
  }, [messages]);
}

interface StatusBarProps {
  /** Tab id whose session detail should be shown. */
  tabId: string;
}

const Separator = (): React.JSX.Element => (
  <span aria-hidden style={{ color: COLOR_BORDER_SUBTLE }}>
    |
  </span>
);

export const StatusBar = ({ tabId }: Readonly<StatusBarProps>): React.JSX.Element | null => {
  // Per-tab session detail, falling back to the global slice (mirrors SessionTabContent).
  const sessionDetail = useStore(
    useShallow((s) => s.tabSessionData[tabId]?.sessionDetail ?? s.sessionDetail)
  );

  const model = useSessionModel(sessionDetail?.messages);

  // No session loaded → render nothing (cleaner than an empty muted bar).
  if (!sessionDetail) return null;

  const { session, metrics } = sessionDetail;

  const shortId = session.id.slice(0, 8);
  const contextConsumption = session.contextConsumption ?? 0;
  const contextPercent =
    contextConsumption > 0
      ? Math.min((contextConsumption / CONTEXT_WINDOW_TOKENS) * 100, 100)
      : 0;
  const contextIsHigh = contextConsumption > 150_000;

  // Live status: colored label only when the session is "live"; else neutral.
  const liveVisual = getLiveStatusVisual(session.status, session.isOngoing);
  const resolvedStatus = resolveSessionStatus(session.status, session.isOngoing);

  return (
    <div
      className="flex h-6 shrink-0 items-center gap-2 overflow-hidden px-3 font-mono text-[11px]"
      style={{
        backgroundColor: COLOR_SURFACE_RAISED,
        borderTop: `1px solid ${COLOR_BORDER_SUBTLE}`,
        color: COLOR_TEXT_MUTED,
      }}
      title={`Session ${session.id}`}
    >
      {/* Session id */}
      <span className="shrink-0 tabular-nums" style={{ color: COLOR_TEXT_SECONDARY }}>
        {shortId}
      </span>

      {/* Model */}
      {model && (
        <>
          <Separator />
          <span className={`shrink-0 ${getModelColorClass(model.family)}`}>{model.name}</span>
        </>
      )}

      {/* Context window consumption */}
      {contextConsumption > 0 && (
        <>
          <Separator />
          <span
            className="shrink-0 tabular-nums"
            style={{ color: contextIsHigh ? 'rgb(251, 191, 36)' : COLOR_TEXT_MUTED }}
            title="Context consumed (compaction-aware) vs 200k window"
          >
            ctx {formatTokensCompact(contextConsumption)} ({contextPercent.toFixed(0)}%)
          </span>
        </>
      )}

      {/* Session token total — reuse the existing MetricsPill chip */}
      {metrics.totalTokens > 0 && (
        <>
          <Separator />
          <MetricsPill
            isolatedOverride={metrics.totalTokens}
            isolatedLabel="Session Tokens"
          />
        </>
      )}

      {/* Spacer pushes live status to the right edge */}
      <div className="ml-auto" />

      {/* Live / ongoing status */}
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
          <span style={{ color: COLOR_TEXT_MUTED }}>
            {resolvedStatus === 'interrupted' ? 'Interrupted' : 'Done'}
          </span>
        )}
      </span>
    </div>
  );
};
