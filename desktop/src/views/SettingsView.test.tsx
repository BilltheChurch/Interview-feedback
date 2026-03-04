import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from './SettingsView';

// Mock audio capture hook — it tries to access navigator.mediaDevices
vi.mock('../hooks/useAudioCapture', () => ({
  useAudioCapture: () => ({
    initMic: vi.fn(),
    initSystem: vi.fn(),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    levels: { mic: 0, system: 0, mixed: 0 },
    isCapturing: false,
    micReady: false,
    systemReady: false,
    error: null,
  }),
}));

// Mock window.desktopAPI used by AccountSection
const mockDesktopAPI = {
  authGetState: vi.fn().mockResolvedValue({
    microsoft: { connected: false, account: null },
    google: { connected: false, account: null },
  }),
  calendarConnectMicrosoft: vi.fn().mockResolvedValue(undefined),
  calendarDisconnectMicrosoft: vi.fn().mockResolvedValue(undefined),
  googleConnect: vi.fn().mockResolvedValue(undefined),
  googleDisconnect: vi.fn().mockResolvedValue(undefined),
};

Object.defineProperty(window, 'desktopAPI', {
  value: mockDesktopAPI,
  writable: true,
});

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Settings heading', () => {
    render(<SettingsView />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders Account section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders Audio Setup section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Audio Setup')).toBeInTheDocument();
  });

  it('renders Processing Providers section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Processing Providers')).toBeInTheDocument();
  });

  it('renders Slack Integration section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Slack Integration')).toBeInTheDocument();
  });

  it('renders Rubric Templates section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Rubric Templates')).toBeInTheDocument();
  });

  it('renders Preferences section', () => {
    render(<SettingsView />);
    expect(screen.getByText('Preferences')).toBeInTheDocument();
  });

  it('renders Microsoft and Google account rows', async () => {
    render(<SettingsView />);
    expect(screen.getByText('Microsoft')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('shows version info', () => {
    render(<SettingsView />);
    expect(screen.getByText(/Interview Feedback Desktop v0\.1\.0/)).toBeInTheDocument();
  });

  it('renders template names in the template list', () => {
    render(<SettingsView />);
    expect(screen.getByText('General Interview')).toBeInTheDocument();
    expect(screen.getByText('Technical Assessment')).toBeInTheDocument();
    expect(screen.getByText('Behavioral Interview')).toBeInTheDocument();
    expect(screen.getByText('Panel Discussion')).toBeInTheDocument();
  });

  it('renders Create Template button', () => {
    render(<SettingsView />);
    expect(screen.getByRole('button', { name: /create template/i })).toBeInTheDocument();
  });

  it('renders Tier 2 Enhanced Processing toggle', () => {
    render(<SettingsView />);
    expect(screen.getByText('Tier 2 Enhanced Processing')).toBeInTheDocument();
    // The toggle button uses role="switch" but has no accessible name — find by role + aria-checked
    const toggles = screen.getAllByRole('switch');
    expect(toggles.length).toBeGreaterThan(0);
    const tier2Toggle = toggles.find((el) => el.getAttribute('aria-checked') === 'false');
    expect(tier2Toggle).toBeDefined();
  });

  it('enables Tier 2 toggle and shows batch endpoint field', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggles = screen.getAllByRole('switch');
    const tier2Toggle = toggles[0];
    await user.click(tier2Toggle);
    expect(tier2Toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByPlaceholderText('http://localhost:8000/batch/process')).toBeInTheDocument();
  });

  it('renders ASR Provider selector', () => {
    render(<SettingsView />);
    expect(screen.getByText('ASR Provider (streaming)')).toBeInTheDocument();
  });

  it('renders LLM Provider selector', () => {
    render(<SettingsView />);
    expect(screen.getByText('LLM Provider (report synthesis)')).toBeInTheDocument();
  });
});
