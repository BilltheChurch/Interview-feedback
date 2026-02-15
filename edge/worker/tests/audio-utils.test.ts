import { describe, it, expect } from "vitest";
import {
  decodeBase64ToBytes,
  bytesToBase64,
  concatUint8Arrays,
  pcm16ToWavBytes,
  truncatePcm16WavToSeconds,
  tailPcm16BytesToWavForSeconds,
  encodeUtf8,
  makeZipStored,
  buildDocxBytesFromText,
  TARGET_SAMPLE_RATE,
  TARGET_CHANNELS,
  ONE_SECOND_PCM_BYTES,
} from "../src/audio-utils";

/* ── Constants ────────────────────────────────── */

describe("constants", () => {
  it("TARGET_SAMPLE_RATE is 16kHz", () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000);
  });

  it("TARGET_CHANNELS is mono", () => {
    expect(TARGET_CHANNELS).toBe(1);
  });

  it("ONE_SECOND_PCM_BYTES is 32000 (16kHz * 1ch * 2bytes)", () => {
    expect(ONE_SECOND_PCM_BYTES).toBe(32000);
  });
});

/* ── base64 round-trip ────────────────────────── */

describe("decodeBase64ToBytes / bytesToBase64", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = bytesToBase64(original);
    const decoded = decodeBase64ToBytes(b64);
    expect(decoded).toEqual(original);
  });

  it("handles empty input", () => {
    const empty = new Uint8Array(0);
    const b64 = bytesToBase64(empty);
    expect(b64).toBe("");
    const decoded = decodeBase64ToBytes(b64);
    expect(decoded.length).toBe(0);
  });

  it("handles large arrays without stack overflow", () => {
    // bytesToBase64 processes in 0x2000 chunks to avoid stack overflow
    const large = new Uint8Array(0x4000 + 100).fill(42);
    const b64 = bytesToBase64(large);
    const decoded = decodeBase64ToBytes(b64);
    expect(decoded.length).toBe(large.length);
    expect(decoded[0]).toBe(42);
    expect(decoded[decoded.length - 1]).toBe(42);
  });
});

/* ── concatUint8Arrays ────────────────────────── */

describe("concatUint8Arrays", () => {
  it("concatenates multiple arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    const result = concatUint8Arrays([a, b, c]);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("returns empty array for empty input", () => {
    expect(concatUint8Arrays([]).length).toBe(0);
  });

  it("handles single array", () => {
    const single = new Uint8Array([1, 2, 3]);
    expect(concatUint8Arrays([single])).toEqual(single);
  });
});

/* ── pcm16ToWavBytes ──────────────────────────── */

describe("pcm16ToWavBytes", () => {
  it("produces valid WAV header (44 bytes)", () => {
    const pcm = new Uint8Array(320); // 10ms of silence at 16kHz
    const wav = pcm16ToWavBytes(pcm);

    // Total size: 44 header + 320 PCM
    expect(wav.length).toBe(44 + 320);

    // RIFF header
    const riff = String.fromCharCode(...wav.subarray(0, 4));
    expect(riff).toBe("RIFF");

    // WAVE format
    const wave = String.fromCharCode(...wav.subarray(8, 12));
    expect(wave).toBe("WAVE");

    // fmt chunk
    const fmt = String.fromCharCode(...wav.subarray(12, 16));
    expect(fmt).toBe("fmt ");

    // data chunk
    const data = String.fromCharCode(...wav.subarray(36, 40));
    expect(data).toBe("data");
  });

  it("sets correct file size in header", () => {
    const pcm = new Uint8Array(1000);
    const wav = pcm16ToWavBytes(pcm);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    // RIFF chunk size = 36 + data size
    expect(view.getUint32(4, true)).toBe(36 + 1000);
    // data chunk size = PCM length
    expect(view.getUint32(40, true)).toBe(1000);
  });

  it("sets sample rate and channels correctly", () => {
    const pcm = new Uint8Array(100);
    const wav = pcm16ToWavBytes(pcm, 44100, 2);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    // Audio format = 1 (PCM)
    expect(view.getUint16(20, true)).toBe(1);
    // Channels
    expect(view.getUint16(22, true)).toBe(2);
    // Sample rate
    expect(view.getUint32(24, true)).toBe(44100);
  });
});

/* ── truncatePcm16WavToSeconds ────────────────── */

describe("truncatePcm16WavToSeconds", () => {
  it("returns original WAV if shorter than maxSeconds", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES); // 1 second
    const wav = pcm16ToWavBytes(pcm);
    const truncated = truncatePcm16WavToSeconds(wav, 5);
    expect(truncated.length).toBe(wav.length);
  });

  it("truncates WAV to specified seconds", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES * 10); // 10 seconds
    const wav = pcm16ToWavBytes(pcm);
    const truncated = truncatePcm16WavToSeconds(wav, 3);
    // Should be 44-byte header + 3 seconds of PCM
    expect(truncated.length).toBe(44 + ONE_SECOND_PCM_BYTES * 3);
  });

  it("returns original if WAV has no data (just header)", () => {
    const wav = new Uint8Array(44); // header only
    const truncated = truncatePcm16WavToSeconds(wav, 1);
    expect(truncated.length).toBe(44);
  });

  it("handles zero maxSeconds by returning original", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES);
    const wav = pcm16ToWavBytes(pcm);
    const truncated = truncatePcm16WavToSeconds(wav, 0);
    expect(truncated.length).toBe(wav.length);
  });
});

/* ── tailPcm16BytesToWavForSeconds ────────────── */

describe("tailPcm16BytesToWavForSeconds", () => {
  it("returns full PCM as WAV when shorter than requested", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES * 2); // 2 seconds
    const wav = tailPcm16BytesToWavForSeconds(pcm, 5);
    expect(wav.length).toBe(44 + ONE_SECOND_PCM_BYTES * 2);
  });

  it("takes tail of PCM when longer than requested", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES * 10); // 10 seconds
    // Fill first byte with 0xFF to verify it gets trimmed
    pcm[0] = 0xff;

    const wav = tailPcm16BytesToWavForSeconds(pcm, 3);
    // Should be 44 + 3 seconds
    expect(wav.length).toBe(44 + ONE_SECOND_PCM_BYTES * 3);
    // First PCM byte (after header) should NOT be 0xFF (tail was taken)
    expect(wav[44]).not.toBe(0xff);
  });

  it("uses minimum of ONE_SECOND_PCM_BYTES even for sub-second requests", () => {
    const pcm = new Uint8Array(ONE_SECOND_PCM_BYTES * 3);
    const wav = tailPcm16BytesToWavForSeconds(pcm, 0.1);
    // maxPcmBytes = max(32000, floor(0.1*32000)) = 32000
    expect(wav.length).toBe(44 + ONE_SECOND_PCM_BYTES);
  });
});

/* ── makeZipStored ────────────────────────────── */

describe("makeZipStored", () => {
  it("creates a valid ZIP with correct magic bytes", () => {
    const zip = makeZipStored([
      { name: "hello.txt", data: encodeUtf8("Hello, World!") },
    ]);
    // Local file header magic: PK\x03\x04
    expect(zip[0]).toBe(0x50); // P
    expect(zip[1]).toBe(0x4b); // K
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it("includes all files in the archive", () => {
    const files = [
      { name: "a.txt", data: encodeUtf8("AAA") },
      { name: "b.txt", data: encodeUtf8("BBB") },
      { name: "c.txt", data: encodeUtf8("CCC") },
    ];
    const zip = makeZipStored(files);

    // End of central directory record should list 3 entries
    // Find EOCD signature (PK\x05\x06)
    let eocdOffset = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (
        zip[i] === 0x50 &&
        zip[i + 1] === 0x4b &&
        zip[i + 2] === 0x05 &&
        zip[i + 3] === 0x06
      ) {
        eocdOffset = i;
        break;
      }
    }
    expect(eocdOffset).toBeGreaterThanOrEqual(0);

    const view = new DataView(
      zip.buffer,
      zip.byteOffset + eocdOffset,
      22
    );
    // Total number of entries (offset 10 in EOCD)
    expect(view.getUint16(10, true)).toBe(3);
  });

  it("handles empty file list", () => {
    const zip = makeZipStored([]);
    // Should still have EOCD
    expect(zip.length).toBe(22); // Just the end of central directory
  });
});

/* ── buildDocxBytesFromText ───────────────────── */

describe("buildDocxBytesFromText", () => {
  it("produces a valid ZIP (DOCX is a ZIP)", () => {
    const docx = buildDocxBytesFromText("Hello World");
    // ZIP magic: PK\x03\x04
    expect(docx[0]).toBe(0x50);
    expect(docx[1]).toBe(0x4b);
  });

  it("includes required OOXML files", () => {
    const docx = buildDocxBytesFromText("Test content");
    const text = new TextDecoder().decode(docx);
    // The ZIP should contain these file names
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("_rels/.rels");
    expect(text).toContain("word/document.xml");
  });

  it("escapes XML special characters in content", () => {
    const docx = buildDocxBytesFromText('A & B < C > D "E" \'F\'');
    const text = new TextDecoder().decode(docx);
    expect(text).toContain("&amp;");
    expect(text).toContain("&lt;");
    expect(text).toContain("&gt;");
    expect(text).toContain("&quot;");
    expect(text).toContain("&apos;");
  });
});
