import { useState } from 'react';
import {
  Mic,
  Wifi,
  Calendar,
  FileText,
  Volume2,
  Play,
  Square,
  Check,
  AlertCircle,
  Settings,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Select } from '../components/ui/Select';
import { StatusDot } from '../components/ui/StatusDot';
import { Chip } from '../components/ui/Chip';

/* ─── AudioSetup ────────────────────────────── */

function AudioSetup() {
  const [testing, setTesting] = useState(false);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Mic className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Audio Setup</h2>
      </div>

      <div className="space-y-4">
        <Select
          label="Microphone"
          options={[
            { value: 'default', label: 'Default — Built-in Microphone' },
            { value: 'external', label: 'External USB Microphone' },
          ]}
          value="default"
          onChange={() => {}}
        />

        <Select
          label="System audio capture"
          options={[
            { value: 'screen', label: 'Screen Audio (ScreenCaptureKit)' },
          ]}
          value="screen"
          onChange={() => {}}
        />

        {/* Self-check */}
        <div className="border border-border rounded-[--radius-card] p-4 bg-surface-hover">
          <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-3">
            Audio Self-Check
          </h3>
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center gap-1.5">
              <StatusDot status={testing ? 'recording' : 'idle'} />
              <span className="text-xs text-ink-secondary">
                {testing ? 'Listening...' : 'Ready'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4 mb-3">
            {/* Visual level bar placeholder */}
            <div className="flex-1">
              <div className="h-3 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-150"
                  style={{ width: testing ? '45%' : '0%' }}
                />
              </div>
            </div>
            <Volume2 className="w-4 h-4 text-ink-tertiary" />
          </div>
          <div className="flex gap-2">
            <Button
              variant={testing ? 'danger' : 'primary'}
              size="sm"
              onClick={() => setTesting(!testing)}
            >
              {testing ? (
                <>
                  <Square className="w-3.5 h-3.5" />
                  Stop Test
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  Test Audio
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ─── GraphConfig ───────────────────────────── */

function GraphConfig() {
  const [clientId, setClientId] = useState('');
  const [connected, setConnected] = useState(false);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Calendar className="w-5 h-5 text-accent" />
        <h2 className="text-base font-semibold text-ink">Microsoft Graph</h2>
        {connected && <Chip variant="success">Connected</Chip>}
      </div>

      <div className="space-y-4">
        <TextField
          label="Azure App (Client) ID"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />

        <TextField
          label="Tenant ID"
          placeholder="common (or your tenant ID)"
          value="common"
          onChange={() => {}}
        />

        {connected ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-success">
              <Check className="w-4 h-4" />
              Calendar connected
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConnected(false)}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-tertiary">
              Sign in with your Microsoft account to sync calendar meetings and create Teams meetings directly from the app.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConnected(true)}
              disabled={!clientId.trim()}
            >
              <Wifi className="w-3.5 h-3.5" />
              Connect Microsoft Account
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── TemplateManager ───────────────────────── */

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

/* ─── Preferences ───────────────────────────── */

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

/* ─── SettingsView (main export) ─────────────── */

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
          <AudioSetup />
          <GraphConfig />
          <TemplateManager />
          <Preferences />
        </div>
      </div>
    </div>
  );
}
