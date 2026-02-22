import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ACS SDK modules
vi.mock('@azure/communication-calling', () => ({
  CallClient: vi.fn().mockImplementation(() => ({
    createCallAgent: vi.fn().mockResolvedValue({
      join: vi.fn().mockReturnValue({
        feature: vi.fn().mockReturnValue({
          captions: {
            on: vi.fn(),
            off: vi.fn(),
            startCaptions: vi.fn().mockResolvedValue(undefined),
          },
        }),
        hangUp: vi.fn().mockResolvedValue(undefined),
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
  })),
  Features: { Captions: 'Captions' },
}));

vi.mock('@azure/communication-common', () => ({
  AzureCommunicationTokenCredential: vi.fn(),
}));

describe('ACSCaptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should be a singleton', async () => {
    const { ACSCaptionService } = await import('../ACSCaptionService');
    const a = ACSCaptionService.getInstance();
    const b = ACSCaptionService.getInstance();
    expect(a).toBe(b);
  });

  it('should have disconnected status initially', async () => {
    const { ACSCaptionService } = await import('../ACSCaptionService');
    const service = ACSCaptionService.getInstance();
    expect(service.getStatus()).toBe('disconnected');
  });
});
