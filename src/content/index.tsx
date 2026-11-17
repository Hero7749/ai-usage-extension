import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import claudeBrandAsset from '../assets/brands/claude-anthropic.jpg?inline';
import codexBrandAsset from '../assets/brands/codex-openai.jpg?inline';
import limitBrandAsset from '../../public/icons/limit-icon-2.0.png?inline';
import { STORAGE_KEYS } from '../shared/constants';
import {
  OVERLAY_DEFAULTS,
  OVERLAY_STORAGE_KEYS,
  normalizeSettings,
  readExtensionSettings,
} from '../shared/settings';
import { useNow } from '../shared/hooks/useNow';
import {
  DEFAULT_OVERLAY_POSITION,
  DRAG_THRESHOLD,
  clampOverlayPosition,
  normalizeOverlayPosition,
  type OverlayPosition,
} from './position';
import { msg, setLocaleMessages } from '../shared/i18n';
import { watchLanguage } from '../shared/language';
import { requestLocaleMessages, requestUsageRefresh } from '../shared/messaging';
import type {
  ClaudeUsage,
  CodexUsage,
  ExternalProviderUsage,
  OverlayProviderId,
  PercentageDisplay,
  UsageLimit,
  UsageState,
} from '../shared/types';
import {
  clampPercent,
  formatRelativeTime,
  formatReset,
  formatUsagePercent,
  getUsageTone,
  isLimitAvailable,
} from '../shared/utils';

const HOST_ID = 'ai-usage-claude-overlay-host';

const TAB_LABEL = 'LIMITS';

/** Must match `.aiu-tab` in overlay.css. */
const TAB_WIDTH = 22;
const TAB_BOTTOM = 14 + 96;
const CARD_WIDTH = 296;
const KEYBOARD_STEP = 16;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  origin: OverlayPosition;
  verticalOnly: boolean;
  moved: boolean;
}

type AnyUsage = {
  session: UsageLimit;
  weekly: UsageLimit;
  lastUpdated: number;
};

const nextReset = (usage: AnyUsage, now: number): string => {
  const upcoming = [usage.session.resetsAt, usage.weekly.resetsAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value) && value > now)
    .sort((a, b) => a - b)[0];

  return upcoming ? formatReset(new Date(upcoming).toISOString(), now) : msg('timeUnknown');
};

interface OverlayMetricProps {
  label: string;
  limit: UsageLimit;
  now: number;
  percentageDisplay: PercentageDisplay;
}

const OverlayMetric: React.FC<OverlayMetricProps> = ({ label, limit, now, percentageDisplay }) => {
  const percent = useMemo(() => clampPercent(limit.percentage), [limit.percentage]);
  const count =
    limit.countLabel ??
    (typeof limit.used === 'number' && typeof limit.limit === 'number' && limit.limit > 0
      ? `${limit.used} / ${limit.limit}`
      : null);

  return (
    <div className="aiu-group">
      <div className="aiu-row">
        <span className="aiu-label">{label}</span>
        <span className="aiu-value">{formatUsagePercent(percent, percentageDisplay)}</span>
      </div>
      <div
        className={`aiu-meter aiu-meter--${getUsageTone(percent)}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuetext={formatUsagePercent(percent, percentageDisplay)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="aiu-meter__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="aiu-meta">
        {count !== null && (
          <>
            <span>{count}</span>
            {' · '}
          </>
        )}
        {msg('resetsLabel', formatReset(limit.resetsAt, now))}
      </div>
    </div>
  );
};

interface OverlayHostConfig {
  brandAsset: string;
  title: string;
  inputSelector: string;
}

const OVERLAY_HOSTS: Record<OverlayProviderId, OverlayHostConfig> = {
  claude: {
    brandAsset: claudeBrandAsset,
    title: 'Claude',
    inputSelector:
      '#chat-input-file-upload-onpage, #chat-input-file-upload-epitaxy, [data-surface="prompt"], [data-testid="chat-input"]',
  },
  codex: {
    brandAsset: codexBrandAsset,
    title: 'Codex',
    inputSelector:
      '#prompt-textarea, [data-testid="composer-footer-actions"], [data-testid="chat-input"], [data-composer-markdown][contenteditable="true"][role="textbox"]',
  },
};

const hostname = window.location.hostname;
const usageField: OverlayProviderId = hostname.includes('claude.ai') ? 'claude' : 'codex';
const enabledKey = OVERLAY_STORAGE_KEYS[usageField].enabled;
const collapsedKey = OVERLAY_STORAGE_KEYS[usageField].collapsed;
const positionKey = OVERLAY_STORAGE_KEYS[usageField].position;
const { brandAsset, title, inputSelector } = OVERLAY_HOSTS[usageField];
const enabledByDefault = OVERLAY_DEFAULTS[usageField];

const UsageOverlay: React.FC = () => {
  const [enabled, setEnabled] = useState(enabledByDefault);
  const [percentageDisplay, setPercentageDisplay] = useState<PercentageDisplay>('used');
  const [localeVersion, setLocaleVersion] = useState(0);
  const [usage, setUsage] = useState<ClaudeUsage | CodexUsage | ExternalProviderUsage | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasInput, setHasInput] = useState(false);
  const [position, setPosition] = useState<OverlayPosition>(DEFAULT_OVERLAY_POSITION);
  const [isDragging, setIsDragging] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const now = useNow(60_000);

  useEffect(
    () =>
      watchLanguage(() => {
        void requestLocaleMessages().then((messages) => {
          setLocaleMessages(messages);
          setLocaleVersion((version) => version + 1);
        });
      }),
    [],
  );

  useEffect(() => {
    const checkElement = (): void => {
      setHasInput(document.querySelector(inputSelector) !== null);
    };

    checkElement();

    const observer = new MutationObserver(checkElement);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let active = true;

    const hydrate = async (): Promise<void> => {
      const snapshot = await chrome.storage.local.get([
        STORAGE_KEYS.usageState,
        enabledKey,
        collapsedKey,
        positionKey,
        STORAGE_KEYS.extensionSettings,
      ]);

      if (!active) {
        return;
      }

      const usageState = (snapshot[STORAGE_KEYS.usageState] ?? {}) as UsageState;
      setUsage(usageState[usageField] ?? null);
      setEnabled(snapshot[enabledKey] ?? enabledByDefault);
      setCollapsed(snapshot[collapsedKey] !== false);
      setPosition(normalizeOverlayPosition(snapshot[positionKey]) ?? DEFAULT_OVERLAY_POSITION);
      setPercentageDisplay(
        normalizeSettings(snapshot[STORAGE_KEYS.extensionSettings]).percentageDisplay,
      );
      setIsLoading(false);
    };

    void hydrate();

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEYS.usageState]) {
        const next = (changes[STORAGE_KEYS.usageState].newValue ?? {}) as UsageState;
        setUsage(next[usageField] ?? null);
      }

      if (changes[enabledKey]) {
        setEnabled(changes[enabledKey].newValue ?? enabledByDefault);
      }

      if (changes[collapsedKey]) {
        setCollapsed(changes[collapsedKey].newValue !== false);
      }

      if (changes[positionKey] && !dragRef.current) {
        setPosition(
          normalizeOverlayPosition(changes[positionKey].newValue) ?? DEFAULT_OVERLAY_POSITION,
        );
      }
      if (changes[STORAGE_KEYS.extensionSettings]) {
        setPercentageDisplay(
          normalizeSettings(changes[STORAGE_KEYS.extensionSettings].newValue).percentageDisplay,
        );
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const runRefresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      await requestUsageRefresh();
    } catch (error) {
      console.debug('Failed to refresh usage limits from overlay', error);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void readExtensionSettings()
      .then((settings) => {
        if (active && settings.refresh.mode === 'auto') return requestUsageRefresh(true);
      })
      .catch((error) => {
        console.debug('Failed to refresh usage limits from overlay', error);
      });
    return () => {
      active = false;
    };
  }, []);

  const clampToViewport = useCallback(
    (next: OverlayPosition, isCollapsed: boolean): OverlayPosition =>
      clampOverlayPosition(next, {
        viewportWidth: document.documentElement.clientWidth || window.innerWidth,
        viewportHeight: document.documentElement.clientHeight || window.innerHeight,
        width: wrapRef.current?.offsetWidth || CARD_WIDTH,
        height: isCollapsed ? TAB_BOTTOM : wrapRef.current?.offsetHeight || TAB_BOTTOM,
        tabWidth: TAB_WIDTH,
      }),
    [],
  );

  const savePosition = useCallback((next: OverlayPosition): void => {
    void chrome.storage.local.set({ [positionKey]: next });
  }, []);

  // Keep the overlay on screen when the window shrinks or the card grows.
  useEffect(() => {
    const reclamp = (): void => {
      if (dragRef.current) return;
      setPosition((prev) => {
        const next = clampToViewport(prev, collapsed);
        return next.top === prev.top && next.right === prev.right ? prev : next;
      });
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [clampToViewport, collapsed, usage, hasInput, enabled]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, source: 'tab' | 'header'): void => {
      // A drag released outside the window never fires its click, so always
      // start a fresh press without a pending click suppression.
      suppressClickRef.current = false;
      if (event.button !== 0) return;
      if (source === 'header' && (event.target as HTMLElement).closest('button')) return;
      // The collapsed tab is pinned to the right edge, so it only moves vertically.
      const verticalOnly = source === 'tab' && collapsed;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: position,
        verticalOnly,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [collapsed, position],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        setIsDragging(true);
      }
      event.preventDefault();
      setPosition(
        clampToViewport(
          {
            top: drag.origin.top + dy,
            right: drag.verticalOnly ? drag.origin.right : drag.origin.right - dx,
          },
          collapsed,
        ),
      );
    },
    [clampToViewport, collapsed],
  );

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag.moved) return;
      suppressClickRef.current = true;
      setIsDragging(false);
      setPosition((current) => {
        savePosition(current);
        return current;
      });
    },
    [savePosition],
  );

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      const delta: Record<string, [number, number]> = {
        ArrowUp: [-KEYBOARD_STEP, 0],
        ArrowDown: [KEYBOARD_STEP, 0],
        ArrowLeft: [0, KEYBOARD_STEP],
        ArrowRight: [0, -KEYBOARD_STEP],
      };
      const step = delta[event.key];
      if (!step || (collapsed && step[1] !== 0)) return;
      event.preventDefault();
      const next = clampToViewport(
        { top: position.top + step[0], right: position.right + step[1] },
        collapsed,
      );
      setPosition(next);
      savePosition(next);
    },
    [clampToViewport, collapsed, position, savePosition],
  );

  const resetPosition = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      if ((event.target as HTMLElement).closest('button')) return;
      setPosition(clampToViewport(DEFAULT_OVERLAY_POSITION, collapsed));
      void chrome.storage.local.remove(positionKey);
    },
    [clampToViewport, collapsed],
  );

  const toggleCollapsed = useCallback((): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setCollapsed((prev) => {
      const next = !prev;
      void chrome.storage.local.set({ [collapsedKey]: next });
      return next;
    });
  }, []);

  if (!enabled || !hasInput) {
    return null;
  }

  return (
    <div className="aiu-root" key={localeVersion}>
      <div
        ref={wrapRef}
        className={`aiu-wrap ${collapsed ? 'aiu-wrap--collapsed' : ''} ${isDragging ? 'aiu-wrap--dragging' : ''}`}
        style={{
          top: `${position.top}px`,
          right: `${position.right}px`,
          transform: collapsed ? `translateX(${position.right + CARD_WIDTH}px)` : undefined,
        }}
      >
        <button
          type="button"
          className="aiu-tab"
          onClick={toggleCollapsed}
          onKeyDown={handleTabKeyDown}
          onPointerDown={(event) => handlePointerDown(event, 'tab')}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          title={collapsed ? msg('showLimits') : msg('hideLimits')}
          aria-label={collapsed ? msg('showLimits') : msg('hideLimits')}
          aria-expanded={!collapsed}
        >
          <img className="aiu-tab-icon" src={limitBrandAsset} alt="" />
          <span className="aiu-tab-label">{TAB_LABEL}</span>
        </button>

        <div className="aiu-card">
          <div
            className="aiu-header"
            onPointerDown={(event) => handlePointerDown(event, 'header')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onDoubleClick={resetPosition}
          >
            <img className="aiu-brand" src={brandAsset} alt="" />
            <div className="aiu-heading">
              <p className="aiu-title">{title}</p>
              <p className="aiu-subtitle">
                {isRefreshing
                  ? msg('refreshing')
                  : usage
                    ? `${msg('updated', formatRelativeTime(usage.lastUpdated, now))} · ${msg('nextResetLabel', nextReset(usage, now))}`
                    : msg('waitingForSnapshot')}
              </p>
            </div>
            <button
              type="button"
              className={`aiu-btn-refresh ${isRefreshing ? 'aiu-btn-refresh--spin' : ''}`}
              onClick={runRefresh}
              disabled={isRefreshing}
              title={msg('refreshUsageLimits')}
              aria-label={msg('refreshUsageLimits')}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="aiu-icon-refresh"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <polyline points="21 3 21 8 16 8" />
              </svg>
            </button>
          </div>

          {usage ? (
            <>
              {isLimitAvailable(usage.session) && (
                <OverlayMetric
                  label={msg('sessionLimit')}
                  limit={usage.session}
                  now={now}
                  percentageDisplay={percentageDisplay}
                />
              )}
              {isLimitAvailable(usage.weekly) && (
                <OverlayMetric
                  label={msg('weeklyLimit')}
                  limit={usage.weekly}
                  now={now}
                  percentageDisplay={percentageDisplay}
                />
              )}
            </>
          ) : isLoading || isRefreshing ? (
            <div className="aiu-loader" aria-hidden="true">
              <div className="aiu-loader__line aiu-loader__line--w80" />
              <div className="aiu-loader__bar" />
              <div className="aiu-loader__line aiu-loader__line--w60" />
            </div>
          ) : (
            <div className="aiu-empty">{msg('emptyOverlay')}</div>
          )}
        </div>
      </div>
    </div>
  );
};

let hostRef: HTMLDivElement | null = null;
let rootRef: ReturnType<typeof createRoot> | null = null;

const attachHost = (): void => {
  const target = document.documentElement;
  if (!target) {
    setTimeout(attachHost, 50);
    return;
  }

  if (hostRef && hostRef.isConnected) {
    return;
  }

  const existing = document.getElementById(HOST_ID) as HTMLDivElement | null;
  if (existing) {
    hostRef = existing;
    if (!rootRef) {
      rootRef = createRoot(existing);
      rootRef.render(<UsageOverlay />);
    }
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  target.appendChild(host);
  hostRef = host;

  if (rootRef) {
    rootRef.unmount();
  }
  rootRef = createRoot(host);
  rootRef.render(<UsageOverlay />);
};

const mount = (): void => {
  attachHost();

  const watcher = new MutationObserver(() => {
    if (!hostRef || !hostRef.isConnected) {
      attachHost();
    }
  });
  watcher.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

const start = async (): Promise<void> => {
  setLocaleMessages(await requestLocaleMessages().catch(() => null));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
};

void start();
