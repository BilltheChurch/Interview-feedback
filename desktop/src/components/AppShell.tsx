import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Home, Settings, Clock, AudioLines } from 'lucide-react';

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/history', icon: Clock, label: 'History' },
  { to: '/settings', icon: Settings, label: 'Settings' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* macOS title bar drag region — full width, above all content */}
      <div className="h-10 shrink-0 drag-region" />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-[52px] flex flex-col items-center py-3 gap-1 border-r border-border bg-surface/80 backdrop-blur-sm drag-region">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-accent-hover flex items-center justify-center mb-4 no-drag">
            <AudioLines className="w-4 h-4 text-white" />
          </div>

          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `no-drag w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-200 ${
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover'
                }`
              }
              title={label}
              aria-label={label}
            >
              <Icon className="w-5 h-5" />
            </NavLink>
          ))}

          {/* Spacer pushes avatar to bottom */}
          <div className="flex-1" />

          {/* User avatar */}
          <div
            className="no-drag w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-xs font-semibold text-accent mb-1"
            title="Account"
          >
            U
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
