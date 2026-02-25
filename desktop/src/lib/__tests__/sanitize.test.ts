import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeHtml } from '../sanitize';

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('passes through clean text unchanged', () => {
    expect(escapeHtml('Hello world 你好')).toBe('Hello world 你好');
  });
});

describe('sanitizeHtml', () => {
  it('strips script tags', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('strips on* event handlers', () => {
    expect(sanitizeHtml('<img onerror="alert(1)" src="x">')).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain('javascript:');
  });

  it('preserves safe HTML', () => {
    const safe = '<p>Hello <b>world</b></p>';
    expect(sanitizeHtml(safe)).toContain('<p>');
    expect(sanitizeHtml(safe)).toContain('<b>');
  });

  it('strips iframe, object, embed, form tags', () => {
    const dirty = '<iframe src="evil.com"></iframe><p>safe</p>';
    expect(sanitizeHtml(dirty)).toBe('<p>safe</p>');
  });
});
