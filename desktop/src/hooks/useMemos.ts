import { useState, useCallback } from 'react';

type MemoType = 'highlight' | 'issue' | 'question' | 'evidence';
type MemoAnchorMode = 'time' | 'utterance';

type Memo = {
  id: string;
  type: MemoType;
  text: string;
  tags: string[];
  timestamp: number;
  anchor?: {
    mode: MemoAnchorMode;
    ref_id?: string;
    time_ms?: number;
  };
  createdAt: Date;
};

type UseMemosReturn = {
  memos: Memo[];
  addMemo: (type: MemoType, text: string, timestamp: number) => Memo;
  updateMemo: (
    id: string,
    updates: Partial<Pick<Memo, 'text' | 'tags' | 'type'>>,
  ) => void;
  removeMemo: (id: string) => void;
  anchorMemo: (id: string, anchor: Memo['anchor']) => void;
  clearAll: () => void;
};

export function useMemos(): UseMemosReturn {
  const [memos, setMemos] = useState<Memo[]>([]);

  const addMemo = useCallback(
    (type: MemoType, text: string, timestamp: number): Memo => {
      const memo: Memo = {
        id: `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        text,
        tags: [],
        timestamp,
        createdAt: new Date(),
      };
      setMemos((prev) => [...prev, memo]);
      return memo;
    },
    [],
  );

  const updateMemo = useCallback(
    (id: string, updates: Partial<Pick<Memo, 'text' | 'tags' | 'type'>>) => {
      setMemos((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      );
    },
    [],
  );

  const removeMemo = useCallback((id: string) => {
    setMemos((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const anchorMemo = useCallback((id: string, anchor: Memo['anchor']) => {
    setMemos((prev) =>
      prev.map((m) => (m.id === id ? { ...m, anchor } : m)),
    );
  }, []);

  const clearAll = useCallback(() => {
    setMemos([]);
  }, []);

  return {
    memos,
    addMemo,
    updateMemo,
    removeMemo,
    anchorMemo,
    clearAll,
  };
}
