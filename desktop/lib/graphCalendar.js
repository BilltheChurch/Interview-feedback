const fs = require("node:fs");
const path = require("node:path");
const { safeStorage } = require("electron");
const { PublicClientApplication } = require("@azure/msal-node");

const DEFAULT_SCOPES = ["User.Read", "Calendars.ReadWrite", "OnlineMeetings.ReadWrite"];

function safeString(value) {
  return String(value || "").trim();
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

class GraphCalendarClient {
  constructor(options = {}) {
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.cachePath = options.cachePath;
    this.clientId = safeString(options.clientId);
    this.tenantId = safeString(options.tenantId) || "common";
    this.scopes = Array.isArray(options.scopes) && options.scopes.length > 0 ? options.scopes : DEFAULT_SCOPES;
    this.openBrowser = typeof options.openBrowser === "function" ? options.openBrowser : undefined;
    this._pca = null;
    this._cacheLoaded = false;
  }

  setConfig(config = {}) {
    const nextClientId = safeString(config.clientId);
    const nextTenantId = safeString(config.tenantId) || "common";
    if (!nextClientId) {
      throw new Error("Microsoft Graph client_id is required");
    }
    const changed = nextClientId !== this.clientId || nextTenantId !== this.tenantId;
    this.clientId = nextClientId;
    this.tenantId = nextTenantId;
    if (changed) {
      this._pca = null;
      this._cacheLoaded = false;
    }
    return this.getStatus();
  }

  _ensureConfigured() {
    if (!this.clientId) {
      throw new Error("Microsoft Graph is not configured. Set client_id first.");
    }
  }

  _getAuthority() {
    return `https://login.microsoftonline.com/${this.tenantId || "common"}`;
  }

  _createPca() {
    return new PublicClientApplication({
      auth: {
        clientId: this.clientId,
        authority: this._getAuthority()
      }
    });
  }

  _ensurePca() {
    this._ensureConfigured();
    if (!this._pca) {
      this._pca = this._createPca();
    }
    return this._pca;
  }

  async _loadCache() {
    const pca = this._ensurePca();
    if (this._cacheLoaded) return pca;
    if (this.cachePath && fs.existsSync(this.cachePath)) {
      let raw;
      const fileContent = fs.readFileSync(this.cachePath);
      if (safeStorage.isEncryptionAvailable()) {
        try {
          raw = safeStorage.decryptString(fileContent);
        } catch {
          // Migration: try reading as plaintext (old format)
          raw = fileContent.toString("utf8");
          // Re-save encrypted
          const encrypted = safeStorage.encryptString(raw);
          fs.writeFileSync(this.cachePath, encrypted, { mode: 0o600 });
        }
      } else {
        raw = fileContent.toString("utf8");
      }
      if (raw && raw.trim()) {
        await pca.getTokenCache().deserialize(raw);
      }
    }
    this._cacheLoaded = true;
    return pca;
  }

  async _saveCache() {
    if (!this.cachePath || !this._pca) return;
    const serialized = await this._pca.getTokenCache().serialize();
    ensureDir(this.cachePath);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(serialized);
      fs.writeFileSync(this.cachePath, encrypted, { mode: 0o600 });
    } else {
      // Fallback for environments without keychain
      fs.writeFileSync(this.cachePath, serialized, { encoding: "utf8", mode: 0o600 });
    }
  }

  async getStatus() {
    if (!this.clientId) {
      return {
        configured: false,
        connected: false,
        account: null,
        tenant_id: this.tenantId || "common"
      };
    }
    const pca = await this._loadCache();
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account = accounts[0] || null;
    return {
      configured: true,
      connected: Boolean(account),
      tenant_id: this.tenantId,
      account: account
        ? {
            username: account.username,
            home_account_id: account.homeAccountId,
            tenant_id: account.tenantId
          }
        : null
    };
  }

  async connect() {
    const pca = await this._loadCache();
    const interactiveRequest = {
      scopes: this.scopes,
      openBrowser: this.openBrowser || undefined,
      successTemplate: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1A2B33}.card{background:#fff;border-radius:16px;padding:48px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;background:#0D6A63;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}svg{width:32px;height:32px}h1{font-size:22px;font-weight:600;margin-bottom:8px;color:#1A2B33}p{font-size:15px;color:#566A77;line-height:1.5}small{display:block;margin-top:20px;font-size:13px;color:#8E9EAB}</style></head><body><div class="card"><div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h1>You're all set!</h1><p>Microsoft account connected successfully.</p><small>You can close this tab and return to Chorus.</small></div></body></html>`,
      errorTemplate: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1A2B33}.card{background:#fff;border-radius:16px;padding:48px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;background:#DC2626;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}svg{width:32px;height:32px}h1{font-size:22px;font-weight:600;margin-bottom:8px;color:#1A2B33}p{font-size:15px;color:#566A77;line-height:1.5}</style></head><body><div class="card"><div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></div><h1>Authentication failed</h1><p>{{error}}</p></div></body></html>`
    };
    const result = await pca.acquireTokenInteractive(interactiveRequest);
    await this._saveCache();
    return {
      connected: true,
      account: {
        username: result?.account?.username || "",
        tenant_id: result?.account?.tenantId || "",
        home_account_id: result?.account?.homeAccountId || ""
      }
    };
  }

  async disconnect() {
    const pca = await this._loadCache();
    const cache = pca.getTokenCache();
    const accounts = await cache.getAllAccounts();
    for (const account of accounts) {
      try {
        await cache.removeAccount(account);
      } catch (error) {
        this.log("[graph] remove account failed", { error: error?.message || String(error) });
      }
    }
    await this._saveCache();
    return {
      connected: false
    };
  }

  async _acquireAccessToken() {
    const pca = await this._loadCache();
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account = accounts[0];
    if (!account) {
      throw new Error("No Microsoft account connected");
    }

    try {
      const token = await pca.acquireTokenSilent({
        account,
        scopes: this.scopes
      });
      return token;
    } catch (_error) {
      const token = await pca.acquireTokenInteractive({
        scopes: this.scopes,
        openBrowser: this.openBrowser || undefined,
        successTemplate: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1A2B33}.card{background:#fff;border-radius:16px;padding:48px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;background:#0D6A63;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}svg{width:32px;height:32px}h1{font-size:22px;font-weight:600;margin-bottom:8px;color:#1A2B33}p{font-size:15px;color:#566A77;line-height:1.5}small{display:block;margin-top:20px;font-size:13px;color:#8E9EAB}</style></head><body><div class="card"><div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h1>You're all set!</h1><p>Microsoft account re-authenticated successfully.</p><small>You can close this tab and return to Chorus.</small></div></body></html>`,
        errorTemplate: "<h1>Authentication failed</h1><p>{{error}}</p>"
      });
      await this._saveCache();
      return token;
    }
  }

  async getUpcomingMeetings(options = {}) {
    const days = Number.isFinite(options.days) ? Math.max(1, Math.min(14, Number(options.days))) : 3;
    const token = await this._acquireAccessToken();
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: end.toISOString(),
      $top: "30",
      $orderby: "start/dateTime",
      $select: "id,subject,start,end,onlineMeeting,isOnlineMeeting,onlineMeetingUrl,attendees,organizer,webLink"
    });

    // Use local timezone so dateTime values match user's clock
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        prefer: `outlook.timezone="${localTz}"`
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph calendarView failed: ${response.status} ${text.slice(0, 240)}`);
    }

    const payload = await response.json();
    const rawItems = Array.isArray(payload?.value) ? payload.value : [];

    const meetings = rawItems.map((item) => {
      const attendees = Array.isArray(item?.attendees) ? item.attendees : [];
      const participants = attendees.map((entry) => {
        const emailAddress = entry?.emailAddress || {};
        return {
          name: safeString(emailAddress.name),
          email: safeString(emailAddress.address),
          type: safeString(entry?.type).toLowerCase() || "required"
        };
      });
      const joinUrl = safeString(item?.onlineMeeting?.joinUrl) || safeString(item?.onlineMeetingUrl) || safeString(item?.webLink);
      return {
        source: "graph",
        meeting_id: safeString(item?.id) || `graph-${Math.random().toString(36).slice(2, 10)}`,
        title: safeString(item?.subject) || "Untitled Meeting",
        start_at: safeString(item?.start?.dateTime),
        end_at: safeString(item?.end?.dateTime),
        join_url: joinUrl,
        participants
      };
    });

    return {
      source: "graph",
      count: meetings.length,
      meetings
    };
  }

  async createOnlineMeeting(options = {}) {
    const subject = safeString(options.subject) || "Interview Session";
    const now = Date.now();
    const startAt = safeString(options.startAt) || new Date(now + 5 * 60 * 1000).toISOString();
    const endAt = safeString(options.endAt) || new Date(now + 65 * 60 * 1000).toISOString();
    const participants = Array.isArray(options.participants) ? options.participants : [];

    const token = await this._acquireAccessToken();
    const response = await fetch("https://graph.microsoft.com/v1.0/me/onlineMeetings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        startDateTime: startAt,
        endDateTime: endAt,
        subject,
        participants: participants.length
          ? {
              attendees: participants
                .map((item) => {
                  const email = safeString(item?.email);
                  const name = safeString(item?.name);
                  if (!email) return null;
                  return {
                    upn: email,
                    identity: {
                      user: {
                        id: email,
                        displayName: name || email
                      }
                    }
                  };
                })
                .filter(Boolean)
            }
          : undefined
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph createOnlineMeeting failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const item = await response.json();
    const joinSettings = item?.joinMeetingIdSettings || {};
    return {
      source: "graph",
      meeting_id: safeString(item?.id) || `graph-online-${Math.random().toString(36).slice(2, 10)}`,
      title: safeString(item?.subject) || subject,
      start_at: safeString(item?.startDateTime) || startAt,
      end_at: safeString(item?.endDateTime) || endAt,
      join_url: safeString(item?.joinWebUrl),
      meeting_code: safeString(joinSettings?.joinMeetingId),
      passcode: safeString(joinSettings?.passcode),
      participants
    };
  }

  async createCalendarEvent(options = {}) {
    const subject = safeString(options.subject) || "Interview Session";
    const now = Date.now();
    const startAt = safeString(options.startAt) || new Date(now + 5 * 60 * 1000).toISOString();
    const endAt = safeString(options.endAt) || new Date(now + 65 * 60 * 1000).toISOString();
    const timeZone = safeString(options.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const participants = Array.isArray(options.participants) ? options.participants : [];

    const token = await this._acquireAccessToken();

    // Build attendees array (only those with email addresses)
    const attendees = participants
      .map((item) => {
        const email = safeString(item?.email);
        const name = safeString(item?.name);
        if (!email) return null;
        return {
          emailAddress: { address: email, name: name || email },
          type: "required"
        };
      })
      .filter(Boolean);

    // Graph API expects dateTime in the specified timeZone (NOT UTC).
    // Strip any trailing 'Z' or timezone offset so Graph treats it as local time.
    // Also ensure seconds are present (datetime-local gives "HH:mm" but Graph may need "HH:mm:ss").
    const normalizeLocalDateTime = (dt) => {
      let cleaned = dt.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
      // Ensure seconds: "2026-02-23T14:00" → "2026-02-23T14:00:00"
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleaned)) {
        cleaned += ":00";
      }
      return cleaned;
    };

    this.log("[graph] createCalendarEvent times", { startAt, endAt, timeZone });

    const body = {
      subject,
      start: { dateTime: normalizeLocalDateTime(startAt), timeZone },
      end: { dateTime: normalizeLocalDateTime(endAt), timeZone },
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness"
    };
    if (attendees.length > 0) {
      body.attendees = attendees;
    }

    const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph createCalendarEvent failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const item = await response.json();

    // Extract join URL from onlineMeeting property
    const joinUrl = safeString(item?.onlineMeeting?.joinUrl) || safeString(item?.onlineMeetingUrl) || "";

    // Calendar event response has conferenceId (dial-in ID) but no joinMeetingId/passcode.
    // Fetch the full online meeting details to get joinMeetingId + passcode.
    let meetingCode = safeString(item?.onlineMeeting?.conferenceId);
    let passcode = "";

    if (joinUrl) {
      try {
        const encodedUrl = encodeURIComponent(joinUrl);
        const meetingResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=JoinWebUrl eq '${encodedUrl}'`,
          {
            headers: {
              authorization: `Bearer ${token.accessToken}`,
              accept: "application/json"
            }
          }
        );
        if (meetingResp.ok) {
          const meetingData = await meetingResp.json();
          const meeting = Array.isArray(meetingData?.value) ? meetingData.value[0] : null;
          if (meeting) {
            if (meeting.joinMeetingIdSettings) {
              meetingCode = safeString(meeting.joinMeetingIdSettings.joinMeetingId) || meetingCode;
              passcode = safeString(meeting.joinMeetingIdSettings.passcode);
            }

            // Enable auto-recording and set spoken language for transcription
            const onlineMeetingId = safeString(meeting.id);
            if (onlineMeetingId) {
              try {
                // Use beta API for meetingSpokenLanguageTag support
                const patchResp = await fetch(
                  `https://graph.microsoft.com/beta/me/onlineMeetings/${onlineMeetingId}`,
                  {
                    method: "PATCH",
                    headers: {
                      authorization: `Bearer ${token.accessToken}`,
                      "content-type": "application/json"
                    },
                    body: JSON.stringify({
                      recordAutomatically: true,
                      meetingSpokenLanguageTag: "zh-CN"
                    })
                  }
                );
                this.log("[graph] Meeting configured", {
                  onlineMeetingId,
                  status: patchResp.status,
                  recordAutomatically: true,
                  meetingSpokenLanguageTag: "zh-CN"
                });
              } catch (patchErr) {
                this.log("[graph] Failed to configure meeting", { error: patchErr?.message || String(patchErr) });
              }
            }
          }
        }
      } catch (err) {
        this.log("[graph] Failed to fetch online meeting details", { error: err?.message || String(err) });
        // Non-fatal: we still have the calendar event and join URL
      }
    }

    return {
      source: "graph",
      meeting_id: safeString(item?.id) || `graph-event-${Math.random().toString(36).slice(2, 10)}`,
      title: safeString(item?.subject) || subject,
      start_at: safeString(item?.start?.dateTime) || startAt,
      end_at: safeString(item?.end?.dateTime) || endAt,
      join_url: joinUrl,
      meeting_code: meetingCode,
      passcode,
      participants,
      web_link: safeString(item?.webLink)
    };
  }
}

module.exports = {
  GraphCalendarClient
};
