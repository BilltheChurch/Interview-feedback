#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TeamsWindowTracker } = require("../lib/teamsWindowTracker.js");

function createFakeWindow(initialBounds) {
  let bounds = { ...initialBounds };
  return {
    getBounds() {
      return { ...bounds };
    },
    setBounds(nextBounds) {
      bounds = { ...nextBounds };
    },
    isDestroyed() {
      return false;
    }
  };
}

async function main() {
  const fakeWindow = createFakeWindow({ x: 100, y: 120, width: 420, height: 860 });
  const fakeScreen = {
    getDisplayMatching() {
      return {
        workArea: { x: 0, y: 0, width: 1728, height: 1117 }
      };
    }
  };

  const responses = [
    { status: "teams_not_found", reason: "warmup" },
    { status: "attached", processName: "Microsoft Teams", teams_bounds: { x: 280, y: 80, width: 960, height: 760 } },
    { status: "attached", processName: "Microsoft Teams", teams_bounds: { x: 420, y: 120, width: 900, height: 730 } }
  ];
  let idx = 0;
  const tracker = new TeamsWindowTracker({
    getOverlayWindow: () => fakeWindow,
    screen: fakeScreen,
    pollMs: 400,
    fetchBounds: async () => {
      const current = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return current;
    }
  });

  const first = await tracker.attach();
  if (first.status !== "teams_not_found") {
    throw new Error(`expected teams_not_found on first attach tick, got ${first.status}`);
  }

  const second = await tracker.tick();
  if (second.status !== "attached") {
    throw new Error(`expected attached after second tick, got ${second.status}`);
  }
  const secondOverlay = second.overlay_bounds || {};

  const third = await tracker.tick();
  if (third.status !== "attached") {
    throw new Error(`expected attached after third tick, got ${third.status}`);
  }
  const thirdOverlay = third.overlay_bounds || {};

  if (
    secondOverlay.x === thirdOverlay.x &&
    secondOverlay.y === thirdOverlay.y &&
    secondOverlay.width === thirdOverlay.width &&
    secondOverlay.height === thirdOverlay.height
  ) {
    throw new Error("expected overlay bounds to update when teams bounds changed");
  }

  await tracker.detach();
  console.log(
    JSON.stringify(
      {
        ok: true,
        transitions: [first.status, second.status, third.status],
        second_overlay: secondOverlay,
        third_overlay: thirdOverlay
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[smoke_teams_attach] ${error?.message || error}`);
  process.exitCode = 1;
});
