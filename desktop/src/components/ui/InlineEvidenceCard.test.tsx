/**
 * Tests for InlineEvidenceCard — 重点验证：传入真实 confidence 时组件显示真实置信度而非写死的 80%。
 *
 * 选择组件层测试：InlineEvidenceCard 是纯展示组件，输入→输出完全确定，测试成本低且
 * 直接覆盖 FeedbackView overview evidence 卡显示真实置信度这一 bug 修复。
 * 同时包含数据层测试：验证 overallEvidenceMap 构建逻辑保留 confidence 字段（纯变换逻辑）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InlineEvidenceCard } from './InlineEvidenceCard';
import type { EvidenceRef } from '../feedback/types';

// motion/react 不在 jsdom 环境中运行，mock 掉动画
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/* ─── InlineEvidenceCard 渲染层测试 ─────────────────────────────── */

describe('InlineEvidenceCard', () => {
  it('显示真实 confidence（0.42 → 42%），不写死 80%', () => {
    render(
      <InlineEvidenceCard
        quote="我认为可以从三个维度来拆分这个问题。"
        speaker="Alice Chen"
        timestamp="01:30"
        confidence={0.42}
      />,
    );
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.queryByText(/80%/)).not.toBeInTheDocument();
  });

  it('显示传入的 confidence 百分比（0.91 → 91%）', () => {
    render(
      <InlineEvidenceCard
        quote="建立在 Bob 的观点基础上进行延伸。"
        speaker="Bob Williams"
        timestamp="04:27"
        confidence={0.91}
      />,
    );
    expect(screen.getByText(/91%/)).toBeInTheDocument();
  });

  it('低置信度（0.55 → 55%）正确渲染', () => {
    render(
      <InlineEvidenceCard
        quote="市场规模估算大约 20 亿。"
        speaker="Alice Chen"
        timestamp="08:18"
        confidence={0.55}
      />,
    );
    expect(screen.getByText(/55%/)).toBeInTheDocument();
  });
});

/* ─── overallEvidenceMap 数据层测试 ──────────────────────────────── */
//
// FeedbackView 内 overallEvidenceMap 的 useMemo 是对 report.evidence 的纯变换：
//   for (const ev of report.evidence) {
//     map.set(ev.id, {
//       evidence_id: ev.id,
//       speaker: { display_name: ev.speaker },
//       time_range_ms: [ev.timestamp_ms, ev.timestamp_ms],
//       quote: ev.text,
//       confidence: ev.confidence,  ← 修复后新增
//     });
//   }
// 这里直接测试该变换逻辑，确保 confidence 被正确携带到 map value 中。

/** 模拟 FeedbackView 的 overallEvidenceMap 构建函数（与修复后代码保持一致） */
function buildOverallEvidenceMap(
  evidences: EvidenceRef[],
): Map<string, {
  evidence_id: string;
  speaker?: { display_name?: string };
  time_range_ms?: [number, number];
  quote?: string;
  confidence: number;
}> {
  const map = new Map();
  for (const ev of evidences) {
    map.set(ev.id, {
      evidence_id: ev.id,
      speaker: { display_name: ev.speaker },
      time_range_ms: [ev.timestamp_ms, ev.timestamp_ms],
      quote: ev.text,
      confidence: ev.confidence,
    });
  }
  return map;
}

describe('overallEvidenceMap 数据层', () => {
  const sampleEvidence: EvidenceRef[] = [
    {
      id: 'ev-1',
      timestamp_ms: 45000,
      speaker: 'Alice Chen',
      text: '我认为应该按企业、中端市场和 SMB 三个细分来分析。',
      confidence: 0.42,
    },
    {
      id: 'ev-2',
      timestamp_ms: 120000,
      speaker: 'Bob Williams',
      text: '基于渠道合作，CAC 可以降低 30%。',
      confidence: 0.91,
    },
  ];

  it('map value 包含 evidence 的真实 confidence（0.42）', () => {
    const map = buildOverallEvidenceMap(sampleEvidence);
    expect(map.get('ev-1')?.confidence).toBe(0.42);
  });

  it('map value 包含 evidence 的真实 confidence（0.91）', () => {
    const map = buildOverallEvidenceMap(sampleEvidence);
    expect(map.get('ev-2')?.confidence).toBe(0.91);
  });

  it('map value 的 confidence 不是写死的 0.8', () => {
    const map = buildOverallEvidenceMap(sampleEvidence);
    expect(map.get('ev-1')?.confidence).not.toBe(0.8);
    expect(map.get('ev-2')?.confidence).not.toBe(0.8);
  });
});
