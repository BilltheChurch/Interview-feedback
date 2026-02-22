import { useState, useEffect } from 'react';
import {
  Mic,
  Calendar,
  FileText,
  Volume2,
  Check,
  AlertCircle,
  Settings,
  LogOut,
  Loader2,
  UserCircle,
  Cpu,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Select } from '../components/ui/Select';
import { StatusDot } from '../components/ui/StatusDot';
import { Chip } from '../components/ui/Chip';
import { useAudioCapture } from '../hooks/useAudioCapture';

/* --- AudioSetup ---------------------------------------- */

function AudioSetup() {
  const { initMic, initSystem, startCapture, stopCapture, levels, isCapturing, micReady, systemReady, error } = useAudioCapture();

  // Auto-init mic + start capturing when component mounts (like Zoom/Teams)
  useEffect(() => {
    let cancelled = false;
    const setup = async () => {
      await initMic();
      if (!cancelled) startCapture();
    };
    setup();
    return () => {
      cancelled = true;
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Mic className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Audio Setup</h2>
      </div>

      <div className="space-y-4">
        {/* Device status indicators */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-ink-tertiary" />
            <span className="text-xs text-ink-secondary">Microphone</span>
            {micReady
              ? <Check className="w-3.5 h-3.5 text-success" />
              : <StatusDot status="reconnecting" />
            }
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-ink-tertiary" />
            <span className="text-xs text-ink-secondary">System Audio</span>
            {systemReady
              ? <Check className="w-3.5 h-3.5 text-success" />
              : <span className="text-xs text-ink-tertiary">Session only</span>
            }
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-error text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Live audio levels -- always visible when capturing */}
        <div className="border border-border rounded-[--radius-card] p-4 bg-surface-hover">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
              Audio Monitor
            </h3>
            <div className="flex items-center gap-1.5">
              <StatusDot status={isCapturing ? 'recording' : 'idle'} />
              <span className="text-xs text-ink-tertiary">
                {isCapturing ? 'Live' : 'Starting...'}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-tertiary w-10">Mic</span>
              <div className="flex-1 h-2.5 rounded-full bg-border overflow-hidden">
                <div className="h-full rounded-full bg-accent transition-all duration-100" style={{ width: `${levels.mic}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-tertiary w-10">System</span>
              <div className="flex-1 h-2.5 rounded-full bg-border overflow-hidden">
                <div className="h-full rounded-full bg-blue-500 transition-all duration-100" style={{ width: `${levels.system}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-tertiary w-10">Mixed</span>
              <div className="flex-1 h-2.5 rounded-full bg-border overflow-hidden">
                <div className="h-full rounded-full bg-purple-500 transition-all duration-100" style={{ width: `${levels.mixed}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* --- AccountSection ------------------------------------ */

type AccountInfo = {
  microsoft: { connected: boolean; account: { username?: string; home_account_id?: string; tenant_id?: string } | null };
  google: { connected: boolean; account: { email?: string } | null };
};

function AccountSection() {
  const [state, setState] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState<'microsoft' | 'google' | null>(null);

  const refreshState = async () => {
    try {
      const result = await window.desktopAPI.authGetState();
      setState(result);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshState();
  }, []);

  const handleMicrosoftConnect = async () => {
    setLoading('microsoft');
    try {
      await window.desktopAPI.calendarConnectMicrosoft();
      await refreshState();
    } catch {
      // ignore
    }
    setLoading(null);
  };

  const handleMicrosoftDisconnect = async () => {
    setLoading('microsoft');
    try {
      await window.desktopAPI.calendarDisconnectMicrosoft();
      await refreshState();
    } catch {
      // ignore
    }
    setLoading(null);
  };

  const handleGoogleConnect = async () => {
    setLoading('google');
    try {
      await window.desktopAPI.googleConnect();
      await refreshState();
    } catch {
      // ignore
    }
    setLoading(null);
  };

  const handleGoogleDisconnect = async () => {
    setLoading('google');
    try {
      await window.desktopAPI.googleDisconnect();
      await refreshState();
    } catch {
      // ignore
    }
    setLoading(null);
  };

  const ms = state?.microsoft;
  const g = state?.google;

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <UserCircle className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Account</h2>
      </div>

      <div className="space-y-3">
        {/* Microsoft account row */}
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 21 21" fill="none">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            <div>
              <p className="text-sm text-ink font-medium">Microsoft</p>
              {ms?.connected && ms.account?.username ? (
                <p className="text-xs text-ink-tertiary">{ms.account.username}</p>
              ) : (
                <p className="text-xs text-ink-tertiary">Not connected</p>
              )}
            </div>
          </div>
          {ms?.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMicrosoftDisconnect}
              disabled={loading === 'microsoft'}
            >
              {loading === 'microsoft' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
              Disconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleMicrosoftConnect}
              disabled={loading === 'microsoft'}
            >
              {loading === 'microsoft' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Connect
            </Button>
          )}
        </div>

        {/* Google account row */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            <div>
              <p className="text-sm text-ink font-medium">Google</p>
              {g?.connected && g.account?.email ? (
                <p className="text-xs text-ink-tertiary">{g.account.email}</p>
              ) : (
                <p className="text-xs text-ink-tertiary">Not connected</p>
              )}
            </div>
          </div>
          {g?.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleGoogleDisconnect}
              disabled={loading === 'google'}
            >
              {loading === 'google' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
              Disconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleGoogleConnect}
              disabled={loading === 'google'}
            >
              {loading === 'google' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Connect
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/* --- TemplateManager ----------------------------------- */

function TemplateManager() {
  const templates = [
    { id: 'general', name: 'General Interview', dimensions: 5, isDefault: true },
    { id: 'technical', name: 'Technical Assessment', dimensions: 5, isDefault: false },
    { id: 'behavioral', name: 'Behavioral Interview', dimensions: 5, isDefault: false },
    { id: 'panel', name: 'Panel Discussion', dimensions: 4, isDefault: false },
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-accent" />
          <h2 className="text-base font-semibold text-ink">Rubric Templates</h2>
        </div>
        <Button variant="secondary" size="sm">
          Create Template
        </Button>
      </div>

      <ul className="space-y-2">
        {templates.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between px-3 py-2.5 rounded-[--radius-button] border border-border bg-surface hover:bg-surface-hover transition-colors"
          >
            <div>
              <p className="text-sm text-ink font-medium">{t.name}</p>
              <p className="text-xs text-ink-tertiary">{t.dimensions} dimensions</p>
            </div>
            <div className="flex items-center gap-2">
              {t.isDefault && <Chip variant="accent">Default</Chip>}
              <Button variant="ghost" size="sm">Edit</Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --- Preferences --------------------------------------- */

function Preferences() {
  const [density, setDensity] = useState('comfort');

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Settings className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Preferences</h2>
      </div>

      <div className="space-y-4">
        <Select
          label="Display density"
          options={[
            { value: 'comfort', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          value={density}
          onChange={(e) => setDensity(e.target.value)}
        />

        <Select
          label="Default export format"
          options={[
            { value: 'markdown', label: 'Markdown' },
            { value: 'text', label: 'Plain Text' },
            { value: 'docx', label: 'Word Document (.docx)' },
          ]}
          value="markdown"
          onChange={() => {}}
        />

        {/* Backend URL */}
        <TextField
          label="API Base URL"
          placeholder="https://your-worker.workers.dev"
          value=""
          onChange={() => {}}
        />

        {/* Version info */}
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-ink-tertiary">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>Interview Feedback Desktop v0.1.0</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* --- ProviderSettings ---------------------------------- */

function ProviderSettings() {
  const [tier2Enabled, setTier2Enabled] = useState(false);
  const [batchEndpoint, setBatchEndpoint] = useState('');
  const [asrProvider, setAsrProvider] = useState('funASR');
  const [llmProvider, setLlmProvider] = useState('dashscope');

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Cpu className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Processing Providers</h2>
      </div>

      <div className="space-y-4">
        <Select
          label="ASR Provider (streaming)"
          options={[
            { value: 'funASR', label: 'FunASR (Aliyun DashScope)' },
            { value: 'groq-whisper', label: 'Groq Whisper' },
            { value: 'openai-whisper', label: 'OpenAI Whisper' },
          ]}
          value={asrProvider}
          onChange={(e) => setAsrProvider(e.target.value)}
        />

        <Select
          label="LLM Provider (report synthesis)"
          options={[
            { value: 'dashscope', label: 'DashScope (Qwen)' },
            { value: 'openai', label: 'OpenAI (GPT-4o)' },
            { value: 'ollama', label: 'Ollama (Local)' },
          ]}
          value={llmProvider}
          onChange={(e) => setLlmProvider(e.target.value)}
        />

        <div className="pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm text-ink font-medium">Tier 2 Enhanced Processing</p>
              <p className="text-xs text-ink-tertiary">
                Re-process audio with Whisper + pyannote after initial report
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={tier2Enabled}
              onClick={() => setTier2Enabled(!tier2Enabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                tier2Enabled ? 'bg-accent' : 'bg-border'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                  tier2Enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {tier2Enabled && (
            <TextField
              label="Batch Processor Endpoint"
              placeholder="http://localhost:8000/batch/process"
              value={batchEndpoint}
              onChange={(e) => setBatchEndpoint(e.target.value)}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

/* --- SettingsView (main export) ------------------------ */

export function SettingsView() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">Settings</h1>
          <p className="text-sm text-ink-secondary">Configure audio, calendar, templates, and preferences</p>
        </div>

        <div className="space-y-4">
          <AccountSection />
          <AudioSetup />
          <ProviderSettings />
          <TemplateManager />
          <Preferences />
        </div>
      </div>
    </div>
  );
}
