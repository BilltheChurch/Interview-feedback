import { describe, it, expect } from 'vitest';
import { parseNameWithAliases } from './rosterAliases';

describe('parseNameWithAliases (R6-roster)', () => {
  it('parses a single alias in half-width parens', () => {
    expect(parseNameWithAliases('Tina (Kenny Tan)')).toEqual({ name: 'Tina', aliases: ['Kenny Tan'] });
  });

  it('parses multiple aliases with mixed separators and full-width parens', () => {
    expect(parseNameWithAliases('Tina（Kenny Tan、KT，小谭）')).toEqual({
      name: 'Tina',
      aliases: ['Kenny Tan', 'KT', '小谭'],
    });
  });

  it('returns just the name when there are no parens', () => {
    expect(parseNameWithAliases('Tina')).toEqual({ name: 'Tina' });
    expect(parseNameWithAliases('  Stephanie  ')).toEqual({ name: 'Stephanie' });
  });

  it('drops empty aliases and aliases identical to the name', () => {
    expect(parseNameWithAliases('Tina (tina, , TINA)')).toEqual({ name: 'Tina' });
  });

  it('treats parens-only input as a literal name (never an empty name)', () => {
    expect(parseNameWithAliases('(Kenny Tan)')).toEqual({ name: '(Kenny Tan)' });
  });

  it('only the trailing parens group is treated as aliases', () => {
    // A name that legitimately contains parens mid-string keeps them.
    expect(parseNameWithAliases('Tina (Kenny) Tan')).toEqual({ name: 'Tina (Kenny) Tan' });
  });
});
