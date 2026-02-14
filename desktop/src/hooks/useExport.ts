import { useState, useCallback, useRef } from 'react';

type ExportFormat = 'text' | 'markdown' | 'docx';

type UseExportReturn = {
  copyToClipboard: (sessionId: string) => Promise<void>;
  exportMarkdown: (sessionId: string) => Promise<void>;
  exportDocx: (sessionId: string) => Promise<void>;
  exporting: boolean;
  lastError: string | null;
};

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function fetchExport(
  baseUrl: string,
  sessionId: string,
  format: ExportFormat,
): Promise<unknown> {
  return window.desktopAPI.exportFeedback({
    baseUrl,
    sessionId,
    body: { format },
  });
}

export function useExport(baseUrl: string): UseExportReturn {
  const [exporting, setExporting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Track mounted state -- no cleanup side effects needed for export
  // but we guard setState calls
  const withGuard = useCallback(
    async (fn: () => Promise<void>) => {
      setExporting(true);
      setLastError(null);
      try {
        await fn();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Export failed';
        if (mountedRef.current) setLastError(msg);
      } finally {
        if (mountedRef.current) setExporting(false);
      }
    },
    [],
  );

  const copyToClipboard = useCallback(
    async (sessionId: string) => {
      await withGuard(async () => {
        const result = (await fetchExport(baseUrl, sessionId, 'text')) as {
          text?: string;
          content?: string;
        };
        const text = result?.text ?? result?.content ?? '';
        await navigator.clipboard.writeText(String(text));
      });
    },
    [baseUrl, withGuard],
  );

  const exportMarkdown = useCallback(
    async (sessionId: string) => {
      await withGuard(async () => {
        const result = (await fetchExport(
          baseUrl,
          sessionId,
          'markdown',
        )) as { text?: string; content?: string };
        const text = result?.text ?? result?.content ?? '';
        const blob = new Blob([String(text)], { type: 'text/markdown' });
        triggerDownload(blob, `feedback-${sessionId}.md`);
      });
    },
    [baseUrl, withGuard],
  );

  const exportDocx = useCallback(
    async (sessionId: string) => {
      await withGuard(async () => {
        const result = (await fetchExport(baseUrl, sessionId, 'docx')) as {
          data?: string;
          content?: string;
        };
        const data = result?.data ?? result?.content ?? '';
        // Assume base64-encoded binary for docx
        const binary = atob(String(data));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        triggerDownload(blob, `feedback-${sessionId}.docx`);
      });
    },
    [baseUrl, withGuard],
  );

  return {
    copyToClipboard,
    exportMarkdown,
    exportDocx,
    exporting,
    lastError,
  };
}
