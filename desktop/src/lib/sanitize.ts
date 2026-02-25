import DOMPurify from 'dompurify';

/**
 * Sanitize user input before sending over IPC or WebSocket.
 * Strips control characters and trims whitespace.
 */
export function sanitizeText(input: string): string {
  // Strip C0 control characters (except newline, tab) and C1 control characters
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').trim();
}

/**
 * Sanitize a URL string: ensure it starts with https:// or http://
 * and strip any embedded credentials or javascript: protocol.
 */
export function sanitizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    // Block non-http(s) protocols
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }
    // Strip embedded credentials
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Sanitize a participant name: letters, numbers, spaces, hyphens, periods, CJK characters.
 */
export function sanitizeName(input: string): string {
  return sanitizeText(input).replace(/[^\p{L}\p{N}\s.\-']/gu, '').slice(0, 120);
}

/**
 * Escape HTML special characters to prevent XSS in generated HTML strings.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize untrusted HTML: strip dangerous tags and attributes.
 * Used for rendering TipTap notes from localStorage.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
