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
    <div className="flex h-screen bg-bg">
      {/* Sidebar */}
      <nav className="w-[52px] flex flex-col items-center py-4 gap-1 border-r border-border bg-surface/80 backdrop-blur-sm drag-region">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-accent-hover flex items-center justify-center mb-4 no-drag">
          <AudioLines className="w-4 h-4 text-white" />
        </div>
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `no-drag w-9 h-9 flex items-center justify-center rounded-lg transition-colors duration-200 ${
                isActive
                  ? 'bg-accent-soft text-accent animate-scale-in'
                  : 'text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover'
              }`
            }
            title={label}
            aria-label={label}
          >
            <Icon className="w-5 h-5" />
          </NavLink>
        ))}
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
