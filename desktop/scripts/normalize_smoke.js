const path = require('node:path');
const fs = require('node:fs');

const {
  normalizeFromFile,
  TARGET_CHANNELS,
  TARGET_CODEC,
  TARGET_SAMPLE_RATE
} = require('../lib/audioPipeline');

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const samplesRoot = path.join(workspaceRoot, 'samples');
  const outputRoot = path.join(workspaceRoot, 'desktop', 'artifacts');

  const inputs = process.argv.slice(2);
  const sampleFiles =
    inputs.length > 0
      ? inputs.map((item) => path.resolve(item))
      : [path.join(samplesRoot, 'Alice.m4a'), path.join(samplesRoot, 'Bob.m4a')];

  const rows = [];
  for (const filePath of sampleFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`input not found: ${filePath}`);
    }

    const result = await normalizeFromFile({
      inputPath: filePath,
      meetingId: 'phase1-smoke',
      outputDir: outputRoot
    });

    rows.push(result);
  }

  const failed = rows.filter((item) => !item.validation.passed);
  const report = {
    target: {
      sampleRate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      codec: TARGET_CODEC
    },
    count: rows.length,
    rows
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }
}

main().catch((error) => {
  console.error(`normalize_smoke failed: ${error.message}`);
  process.exit(1);
});
