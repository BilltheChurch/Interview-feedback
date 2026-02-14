import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Deep link payload from main process via preload.js.
 * Parsed from: interviewfeedback://start?session_id=...&mode=...&teams_join_url=...
 */
type DeepLinkPayload = {
  raw_url: string;
  session_id: string;
  mode: string;
  teams_join_url: string;
  template_id: string;
  booking_ref: string;
  return_url: string;
  participants: Array<{ name: string }>;
};

type UseDeepLinkOptions = {
  /** Callback when a deep link is received — use to pre-fill session config */
  onDeepLink?: (payload: DeepLinkPayload) => void;
};

/**
 * Listens for deep link events from the Electron main process.
 *
 * The main.js already handles:
 * 1. Protocol registration (app.setAsDefaultProtocolClient)
 * 2. URL parsing (parseDeepLink)
 * 3. Dispatching via IPC (deeplink:start event)
 *
 * This hook subscribes to the IPC event and navigates to /setup with pre-filled data.
 */
export function useDeepLink({ onDeepLink }: UseDeepLinkOptions = {}) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!window.desktopAPI?.onDeepLinkStart) return;

    const unsubscribe = window.desktopAPI.onDeepLinkStart((raw: unknown) => {
      const payload = raw as DeepLinkPayload;

      // Notify caller for state pre-filling
      onDeepLink?.(payload);

      // Navigate to setup with deep link data as state
      navigate('/setup', {
        state: {
          fromDeepLink: true,
          sessionId: payload.session_id,
          mode: payload.mode || '1v1',
          teamsJoinUrl: payload.teams_join_url,
          templateId: payload.template_id,
          participants: payload.participants || [],
          returnUrl: payload.return_url,
        },
      });

      // Auto-open Teams meeting URL if provided
      if (payload.teams_join_url) {
        window.desktopAPI.openExternalUrl({ url: payload.teams_join_url }).catch(() => {
          // Silently handle — Teams URL opening is best-effort
        });
      }
    });

    return unsubscribe;
  }, [navigate, onDeepLink]);
}
