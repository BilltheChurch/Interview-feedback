const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { safeStorage } = require("electron");
const { OAuth2Client } = require("google-auth-library");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
];

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

class GoogleCalendarClient {
  constructor(options = {}) {
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.cachePath = options.cachePath;
    this.clientId = String(options.clientId || "").trim();
    this.clientSecret = String(options.clientSecret || "").trim();
    this.openBrowser = typeof options.openBrowser === "function" ? options.openBrowser : undefined;
    this._tokens = null;
    this._cacheLoaded = false;
  }

  _loadCache() {
    if (this._cacheLoaded) return;
    if (this.cachePath && fs.existsSync(this.cachePath)) {
      try {
        let raw;
        const fileContent = fs.readFileSync(this.cachePath);
        if (safeStorage.isEncryptionAvailable()) {
          try {
            raw = safeStorage.decryptString(fileContent);
          } catch {
            // Migration: try reading as plaintext (old format)
            raw = fileContent.toString("utf8");
            // Re-save encrypted
            if (raw && raw.trim()) {
              const encrypted = safeStorage.encryptString(raw);
              fs.writeFileSync(this.cachePath, encrypted, { mode: 0o600 });
            }
          }
        } else {
          raw = fileContent.toString("utf8");
        }
        if (raw && raw.trim()) {
          this._tokens = JSON.parse(raw);
        }
      } catch (error) {
        this.log("[google] cache load failed", { error: error?.message || String(error) });
      }
    }
    this._cacheLoaded = true;
  }

  _saveCache() {
    if (!this.cachePath) return;
    ensureDir(this.cachePath);
    if (this._tokens) {
      const serialized = JSON.stringify(this._tokens, null, 2);
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(serialized);
        fs.writeFileSync(this.cachePath, encrypted, { mode: 0o600 });
      } else {
        // Fallback for environments without keychain
        fs.writeFileSync(this.cachePath, serialized, { encoding: "utf8", mode: 0o600 });
      }
    } else if (fs.existsSync(this.cachePath)) {
      fs.unlinkSync(this.cachePath);
    }
  }

  _createOAuth2Client(redirectUri) {
    return new OAuth2Client(this.clientId, this.clientSecret || "", redirectUri);
  }

  async connect() {
    if (!this.clientId) {
      throw new Error("Google Calendar client ID is not configured");
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer();
      let settled = false;

      const settle = (err, result) => {
        if (settled) return;
        settled = true;
        server.close(() => {});
        if (err) reject(err);
        else resolve(result);
      };

      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}`;
        const oauth2Client = this._createOAuth2Client(redirectUri);
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: SCOPES,
          prompt: "consent"
        });

        this.log("[google] opening browser for auth", { port });

        server.on("request", async (req, res) => {
          try {
            const url = new URL(req.url, redirectUri);
            const code = url.searchParams.get("code");
            const error = url.searchParams.get("error");

            if (error) {
              res.writeHead(200, { "content-type": "text/html" });
              res.end("<h1>Authentication failed</h1><p>" + error + "</p>");
              settle(new Error(`Google auth error: ${error}`));
              return;
            }

            if (!code) {
              res.writeHead(400, { "content-type": "text/html" });
              res.end("<h1>Missing authorization code</h1>");
              return;
            }

            const { tokens } = await oauth2Client.getToken(code);
            this._tokens = tokens;
            this._saveCache();

            // Fetch user email
            let email = "";
            try {
              oauth2Client.setCredentials(tokens);
              const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                headers: { authorization: `Bearer ${tokens.access_token}` }
              });
              if (resp.ok) {
                const info = await resp.json();
                email = info.email || "";
              }
            } catch (e) {
              this.log("[google] userinfo fetch failed", { error: e?.message || String(e) });
            }

            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1A2B33}.card{background:#fff;border-radius:16px;padding:48px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;background:#0D6A63;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}svg{width:32px;height:32px}h1{font-size:22px;font-weight:600;margin-bottom:8px;color:#1A2B33}p{font-size:15px;color:#566A77;line-height:1.5}small{display:block;margin-top:20px;font-size:13px;color:#8E9EAB}</style></head><body><div class="card"><div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h1>You're all set!</h1><p>Google account connected successfully.</p><small>You can close this tab and return to Chorus.</small></div></body></html>`);

            settle(null, {
              connected: true,
              account: { email }
            });
          } catch (err) {
            res.writeHead(500, { "content-type": "text/html" });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1A2B33}.card{background:#fff;border-radius:16px;padding:48px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;background:#DC2626;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}svg{width:32px;height:32px}h1{font-size:22px;font-weight:600;margin-bottom:8px;color:#1A2B33}p{font-size:15px;color:#566A77;line-height:1.5}</style></head><body><div class="card"><div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></div><h1>Authentication failed</h1><p>Something went wrong. Please try again.</p></div></body></html>`);
            settle(err);
          }
        });

        // Open browser
        if (this.openBrowser) {
          this.openBrowser(authUrl).catch((err) => {
            settle(err);
          });
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        settle(new Error("Google authentication timed out"));
      }, 5 * 60 * 1000);
    });
  }

  async disconnect() {
    this._tokens = null;
    this._saveCache();
    return { connected: false };
  }

  async getStatus() {
    this._loadCache();
    if (!this.clientId) {
      return { configured: false, connected: false, account: null };
    }
    if (!this._tokens || !this._tokens.access_token) {
      return { configured: true, connected: false, account: null };
    }

    // Try to get user email from cached token
    let email = "";
    try {
      const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { authorization: `Bearer ${this._tokens.access_token}` }
      });
      if (resp.ok) {
        const info = await resp.json();
        email = info.email || "";
      }
    } catch {
      // Token may be expired but we still have refresh token
    }

    return {
      configured: true,
      connected: true,
      account: { email }
    };
  }

  async _getAccessToken() {
    this._loadCache();
    if (!this._tokens) {
      throw new Error("No Google account connected");
    }

    // Check if token is expired and refresh if needed
    if (this._tokens.expiry_date && Date.now() >= this._tokens.expiry_date - 60000) {
      if (!this._tokens.refresh_token) {
        throw new Error("Google token expired and no refresh token available");
      }
      const oauth2Client = this._createOAuth2Client("");
      oauth2Client.setCredentials(this._tokens);
      const { credentials } = await oauth2Client.refreshAccessToken();
      this._tokens = credentials;
      this._saveCache();
    }

    return this._tokens.access_token;
  }

  async getUpcomingMeetings(options = {}) {
    const days = Number.isFinite(options.days) ? Math.max(1, Math.min(14, Number(options.days))) : 3;
    const accessToken = await this._getAccessToken();

    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: "30",
      singleEvents: "true",
      orderBy: "startTime"
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Calendar API failed: ${response.status} ${text.slice(0, 240)}`);
    }

    const payload = await response.json();
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];

    const meetings = rawItems.map((item) => {
      const attendees = Array.isArray(item?.attendees) ? item.attendees : [];
      const participants = attendees.map((entry) => ({
        name: String(entry?.displayName || "").trim(),
        email: String(entry?.email || "").trim(),
        type: entry?.organizer ? "organizer" : "required"
      }));

      const startObj = item?.start || {};
      const endObj = item?.end || {};

      return {
        source: "google",
        meeting_id: String(item?.id || `google-${Math.random().toString(36).slice(2, 10)}`),
        title: String(item?.summary || "Untitled Meeting"),
        start_at: String(startObj.dateTime || startObj.date || ""),
        end_at: String(endObj.dateTime || endObj.date || ""),
        join_url: String(item?.hangoutLink || item?.htmlLink || ""),
        participants
      };
    });

    return {
      source: "google",
      count: meetings.length,
      meetings
    };
  }
}

module.exports = {
  GoogleCalendarClient
};
