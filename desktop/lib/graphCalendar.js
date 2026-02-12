const fs = require("node:fs");
const path = require("node:path");
const { PublicClientApplication } = require("@azure/msal-node");

const DEFAULT_SCOPES = ["User.Read", "Calendars.Read"];

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
      const serialized = fs.readFileSync(this.cachePath, "utf8");
      if (serialized.trim()) {
        await pca.getTokenCache().deserialize(serialized);
      }
    }
    this._cacheLoaded = true;
    return pca;
  }

  async _saveCache() {
    if (!this.cachePath || !this._pca) return;
    const serialized = await this._pca.getTokenCache().serialize();
    ensureDir(this.cachePath);
    fs.writeFileSync(this.cachePath, serialized, { encoding: "utf8", mode: 0o600 });
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
    const result = await pca.acquireTokenByDeviceCode({
      scopes: this.scopes,
      deviceCodeCallback: (response) => {
        this.log("[graph] device code", {
          message: response?.message,
          userCode: response?.userCode,
          verificationUri: response?.verificationUri
        });
      }
    });
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
      const token = await pca.acquireTokenByDeviceCode({
        scopes: this.scopes,
        deviceCodeCallback: (response) => {
          this.log("[graph] device code (reauth)", {
            message: response?.message,
            userCode: response?.userCode,
            verificationUri: response?.verificationUri
          });
        }
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

    const response = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        prefer: 'outlook.timezone="UTC"'
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
}

module.exports = {
  GraphCalendarClient
};
