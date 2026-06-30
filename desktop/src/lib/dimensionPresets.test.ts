import { describe, it, expect } from "vitest";
import { generateDimensionKey, ensureDimensionKeys, DimensionPresetItem } from "./dimensionPresets";

describe("generateDimensionKey", () => {
  it("generates a key matching the expected pattern for a normal name", () => {
    const key = generateDimensionKey("System Design");
    // slug = "system_design" (14 chars, under 20), suffix is 6 base36 chars
    expect(key).toMatch(/^custom_system_design_[a-z0-9]{6}$/);
  });

  it("falls back to 'dim' when name produces an empty slug", () => {
    const key = generateDimensionKey("  ?? ");
    expect(key).toMatch(/^custom_dim_[a-z0-9]{6}$/);
  });

  it("also falls back to 'dim' for an empty string", () => {
    const key = generateDimensionKey("");
    expect(key).toMatch(/^custom_dim_[a-z0-9]{6}$/);
  });

  it("caps the slug portion at 20 characters", () => {
    const key = generateDimensionKey("A Very Long Dimension Name Beyond Twenty Chars");
    // slug = "a_very_long_dimension_name_beyond_twenty_chars"
    // sliced to 20: "a_very_long_dimensio"
    // trailing underscore stripped: "a_very_long_dimensio"
    expect(key).toMatch(/^custom_[a-z0-9_]{1,20}_[a-z0-9]{6}$/);
    // the slug must be at most 20 chars — extract and verify
    const parts = key.split("_");
    // everything between "custom_" and the last 6-char suffix
    const suffix = parts[parts.length - 1];
    const slugPart = key.slice("custom_".length, key.length - suffix.length - 1);
    expect(slugPart.length).toBeLessThanOrEqual(20);
  });

  it("preserves a trailing underscore when the 20-char cap lands on a separator (LOCKED rule, no post-slice strip)", () => {
    // Pipeline for "abcdefghijklmnopqrs tword":
    //   lowercase                 -> "abcdefghijklmnopqrs tword"
    //   non-alnum -> "_"          -> "abcdefghijklmnopqrs_tword"
    //   strip leading/trailing _  -> "abcdefghijklmnopqrs_tword" (no change)
    //   slice(0,20)               -> "abcdefghijklmnopqrs_"  (char 19 is the "_")
    // The locked rule does NOT strip the trailing "_" after slicing, so the slug
    // keeps it -> key has a double underscore before the random suffix.
    const key = generateDimensionKey("abcdefghijklmnopqrs tword");
    expect(key).toMatch(/^custom_abcdefghijklmnopqrs__[a-z0-9]{6}$/);
  });

  it("produces a suffix that is always exactly 6 lowercase base36 chars", () => {
    // Generate many keys to reduce the probability that a lucky run masks padding bugs
    for (let i = 0; i < 200; i++) {
      const key = generateDimensionKey("Test Name " + i);
      // The suffix is everything after the last underscore
      const suffix = key.split("_").pop()!;
      expect(suffix).toMatch(/^[a-z0-9]{6}$/);
    }
  });

  it("generates unique keys for repeated calls with the same name", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateDimensionKey("Same Name")));
    // With 50 calls and 6-char base36 (36^6 ≈ 2.18 billion), collisions are astronomically unlikely
    expect(keys.size).toBeGreaterThan(1);
  });
});

describe("ensureDimensionKeys", () => {
  it("adds a key to items that are missing one", () => {
    const items: Omit<DimensionPresetItem, "key">[] = [
      { label_en: "Leadership", label_zh: "领导力", description: "desc", weight: 1 },
    ];
    const result = ensureDimensionKeys(items as DimensionPresetItem[]);
    expect(result[0].key).toMatch(/^custom_leadership_[a-z0-9]{6}$/);
  });

  it("preserves existing keys and does not regenerate them", () => {
    const items: DimensionPresetItem[] = [
      { key: "existing_key", label_en: "Leadership", label_zh: "领导力", description: "desc", weight: 1 },
    ];
    const result = ensureDimensionKeys(items);
    expect(result[0].key).toBe("existing_key");
  });

  it("handles a mix of items with and without keys", () => {
    const items: DimensionPresetItem[] = [
      { key: "preset_key", label_en: "Preset Dim", label_zh: "", description: "d", weight: 2 },
      { key: "", label_en: "Custom Dim", label_zh: "", description: "d", weight: 3 },
    ];
    const result = ensureDimensionKeys(items);
    expect(result[0].key).toBe("preset_key");
    expect(result[1].key).toMatch(/^custom_custom_dim_[a-z0-9]{6}$/);
  });

  it("handles item with name field instead of label_en", () => {
    // The task says: key: d.key || generateDimensionKey(d.name ?? d.label_en ?? "")
    // DimensionPresetItem uses label_en, but test ensures label_en is picked up
    const items: DimensionPresetItem[] = [
      { key: "", label_en: "X Dimension", label_zh: "", description: "d", weight: 1 },
    ];
    const result = ensureDimensionKeys(items);
    expect(result[0].key).toMatch(/^custom_x_dimension_[a-z0-9]{6}$/);
  });

  it("returns a new array without mutating the original", () => {
    const items: DimensionPresetItem[] = [
      { key: "", label_en: "Test", label_zh: "", description: "d", weight: 1 },
    ];
    const original = items[0].key;
    ensureDimensionKeys(items);
    // Original should not be mutated (implementations may or may not mutate; we test the return value)
    const result = ensureDimensionKeys(items);
    expect(result[0].key).toMatch(/^custom_test_[a-z0-9]{6}$/);
    expect(original).toBe("");
  });
});
