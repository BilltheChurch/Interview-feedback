const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PROCESS_CANDIDATES = [
  "Microsoft Teams",
  "Microsoft Teams (work or school)",
  "Teams"
];

const PERMISSION_KEYWORDS = [
  "not authorized",
  "assistive",
  "accessibility",
  "automation",
  "not permitted",
  "not allowed",
  "appleevent",
  "不允许辅助访问",
  "辅助访问",
  "没有权限",
  "未获授权",
  "不允许自动化"
];

const PERMISSION_ERROR_CODES = new Set([-1743, -25211, -1719, -10004]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseResultLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) {
    return { status: "error", reason: "empty osascript response" };
  }
  const parts = line.split("|");
  const kind = parts[0];

  if (kind === "ok" && parts.length >= 6) {
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const width = Number(parts[4]);
    const height = Number(parts[5]);
    if (![x, y, width, height].every(Number.isFinite)) {
      return { status: "error", reason: `invalid bounds payload: ${line}` };
    }
    return {
      status: "attached",
      processName: parts[1],
      teams_bounds: { x, y, width, height }
    };
  }

  if (kind === "teams_not_found") {
    return { status: "teams_not_found", reason: "teams window not found" };
  }

  if (kind === "permission_required") {
    return {
      status: "permission_required",
      reason: parts.slice(1).join("|") || "macOS accessibility/automation permission required"
    };
  }

  if (kind === "error") {
    const errorCode = Number(parts[1]);
    const reason = parts.slice(2).join("|") || parts.slice(1).join("|") || "unknown osascript error";
    if (isPermissionError({ errorCode, reason })) {
      return {
        status: "permission_required",
        reason
      };
    }
    return {
      status: "error",
      reason
    };
  }

  return { status: "error", reason: `unrecognized osascript response: ${line}` };
}

function buildAppleScriptLines() {
  const listExpr = `{${PROCESS_CANDIDATES.map((name) => `"${name}"`).join(", ")}}`;
  return [
    `set processNames to ${listExpr}`,
    "try",
    '  tell application "System Events"',
    "    repeat with procName in processNames",
    "      if exists process procName then",
    "        tell process procName",
    "          if (count of windows) > 0 then",
    "            set winRef to first window",
    "            set winPos to position of winRef",
    "            set winSize to size of winRef",
    '            return "ok|" & (procName as text) & "|" & (item 1 of winPos) & "|" & (item 2 of winPos) & "|" & (item 1 of winSize) & "|" & (item 2 of winSize)',
    "          end if",
    "        end tell",
    "      end if",
    "    end repeat",
    "  end tell",
    '  return "teams_not_found"',
    "on error errMsg number errNum",
    '  return "error|" & errNum & "|" & errMsg',
    "end try"
  ];
}

function isPermissionError(input) {
  const code = Number(input?.errorCode);
  if (PERMISSION_ERROR_CODES.has(code)) {
    return true;
  }
  const reason = String(input?.reason || "").toLowerCase();
  return PERMISSION_KEYWORDS.some((keyword) => reason.includes(keyword));
}

async function fetchTeamsBoundsWithAppleScript() {
  const scriptLines = buildAppleScriptLines();
  const args = [];
  for (const line of scriptLines) {
    args.push("-e", line);
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, { timeout: 2500 });
    return parseResultLine(stdout);
  } catch (error) {
    const stderr = String(error?.stderr || "");
    const stdout = String(error?.stdout || "");
    const combined = `${stdout}\n${stderr}`.trim();
    if (isPermissionError({ reason: combined })) {
      return {
        status: "permission_required",
        reason: combined || "macOS accessibility/automation permission required"
      };
    }
    return {
      status: "error",
      reason: combined || error?.message || "osascript failed"
    };
  }
}

class TeamsWindowTracker {
  constructor(options = {}) {
    if (typeof options.getOverlayWindow !== "function") {
      throw new Error("TeamsWindowTracker requires getOverlayWindow()");
    }
    if (!options.screen) {
      throw new Error("TeamsWindowTracker requires electron screen");
    }
    this.getOverlayWindow = options.getOverlayWindow;
    this.screen = options.screen;
    this.fetchBounds = typeof options.fetchBounds === "function" ? options.fetchBounds : fetchTeamsBoundsWithAppleScript;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs >= 200 ? options.pollMs : 400;

    this.pollTimer = undefined;
    this.attached = false;
    this.lastStatus = {
      status: "teams_not_found",
      reason: "tracker idle",
      teams_bounds: null,
      overlay_bounds: null
    };
    this.lastBoundsKey = "";
  }

  status() {
    return {
      ...this.lastStatus,
      attached: this.attached
    };
  }

  async attach() {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.tick().catch((error) => {
          this.lastStatus = {
            status: "error",
            reason: error?.message || String(error),
            teams_bounds: null,
            overlay_bounds: null
          };
        });
      }, this.pollMs);
    }
    this.attached = true;
    this.lastStatus = {
      status: "searching",
      reason: "looking for teams window",
      teams_bounds: null,
      overlay_bounds: null
    };
    await this.tick();
    return this.status();
  }

  async detach() {
    this.attached = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.lastStatus = {
      status: "teams_not_found",
      reason: "detached",
      teams_bounds: null,
      overlay_bounds: null
    };
    this.lastBoundsKey = "";
    return this.status();
  }

  computeOverlayBounds(teamsBounds, overlayBounds) {
    const width = clamp(Number(overlayBounds?.width) || 420, 380, 520);
    const display = this.screen.getDisplayMatching({
      x: teamsBounds.x,
      y: teamsBounds.y,
      width: teamsBounds.width,
      height: teamsBounds.height
    });
    const workArea = display.workArea;
    const gap = 12;
    const rightCandidate = teamsBounds.x + teamsBounds.width + gap;
    const rightOverflow = rightCandidate + width > workArea.x + workArea.width;
    const x = rightOverflow
      ? teamsBounds.x - width - gap
      : rightCandidate;
    const clampedX = clamp(x, workArea.x, workArea.x + workArea.width - width);

    const desiredHeight = Number(overlayBounds?.height) || 860;
    const height = clamp(desiredHeight, 640, workArea.height);
    const y = clamp(
      teamsBounds.y,
      workArea.y,
      workArea.y + workArea.height - height
    );

    return {
      x: Math.round(clampedX),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  async tick() {
    if (!this.attached) {
      return this.status();
    }
    const overlay = this.getOverlayWindow();
    if (!overlay || overlay.isDestroyed()) {
      this.lastStatus = {
        status: "error",
        reason: "overlay window unavailable",
        teams_bounds: null,
        overlay_bounds: null
      };
      return this.status();
    }

    const result = await this.fetchBounds();
    if (result.status === "permission_required") {
      this.lastStatus = {
        status: "permission_required",
        reason: result.reason || "macOS accessibility/automation permission required",
        teams_bounds: null,
        overlay_bounds: null
      };
      return this.status();
    }
    if (result.status === "teams_not_found") {
      this.lastStatus = {
        status: "teams_not_found",
        reason: result.reason || "teams window not found",
        teams_bounds: null,
        overlay_bounds: null
      };
      return this.status();
    }
    if (result.status !== "attached" || !result.teams_bounds) {
      this.lastStatus = {
        status: "error",
        reason: result.reason || "unable to resolve teams bounds",
        teams_bounds: null,
        overlay_bounds: null
      };
      return this.status();
    }

    const overlayBounds = this.computeOverlayBounds(result.teams_bounds, overlay.getBounds());
    const boundsKey = `${overlayBounds.x}:${overlayBounds.y}:${overlayBounds.width}:${overlayBounds.height}`;
    if (boundsKey !== this.lastBoundsKey) {
      overlay.setBounds(overlayBounds, true);
      this.lastBoundsKey = boundsKey;
      this.log("teams attach setBounds", {
        process: result.processName,
        teams: result.teams_bounds,
        overlay: overlayBounds
      });
    }

    this.lastStatus = {
      status: "attached",
      reason: null,
      process_name: result.processName,
      teams_bounds: result.teams_bounds,
      overlay_bounds: overlayBounds
    };
    return this.status();
  }
}

module.exports = {
  TeamsWindowTracker,
  fetchTeamsBoundsWithAppleScript
};
