import {
  BarChart3,
  CalendarDays,
  CircleHelp,
  Clock3,
  History,
  LayoutGrid,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../context/AuthContext";

const primaryNavigation = [
  { to: "/analytics", label: "Overview", icon: LayoutGrid },
  { to: "/composer", label: "Create post", icon: Plus },
  { to: "/queue", label: "Queue", icon: Clock3, count: "2,487" },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
];

const contentNavigation = [
  { to: "/history", label: "Published", icon: History },
  { to: "/failed", label: "Needs attention", icon: TriangleAlert, count: "3" },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
];

const settingsNavigation = [
  { to: "/accounts", label: "Connected accounts", icon: UsersRound },
  { to: "/setup", label: "Setup status", icon: SlidersHorizontal },
  { to: "/settings", label: "Settings", icon: Settings },
];

const titles: Record<string, { eyebrow: string; title: string }> = {
  "/analytics": {
    eyebrow: "Thursday, 3 September",
    title: "Good morning, Adeel",
  },
  "/composer": { eyebrow: "New content", title: "Create a post" },
  "/queue": { eyebrow: "Publishing pipeline", title: "Queue" },
  "/calendar": { eyebrow: "September 2026", title: "Content calendar" },
  "/history": { eyebrow: "Archive", title: "Published posts" },
  "/failed": { eyebrow: "Action required", title: "Needs attention" },
  "/accounts": { eyebrow: "Platform access", title: "Connected accounts" },
  "/setup": { eyebrow: "First-run checklist", title: "Setup status" },
  "/settings": { eyebrow: "Installation", title: "Settings" },
};

function NavigationGroup({
  label,
  items,
  showDemoCounts,
}: {
  label?: string;
  items: typeof primaryNavigation;
  showDemoCounts: boolean;
}) {
  return (
    <div className="nav-group">
      {label && <p className="nav-label">{label}</p>}
      {items.map(({ to, label: itemLabel, icon: Icon, count }) => (
        <NavLink
          key={`${to}-${itemLabel}`}
          to={to}
          className={({ isActive }) =>
            `nav-item ${isActive && itemLabel !== "Analytics" ? "active" : ""}`
          }
        >
          <Icon size={18} strokeWidth={1.8} />
          <span>{itemLabel}</span>
          {showDemoCounts && count && (
            <span className="nav-count">{count}</span>
          )}
        </NavLink>
      ))}
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  const { demoMode, signOut, session } = useAuth();
  const baseHeading = titles[location.pathname] ?? titles["/analytics"]!;
  const today = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Melbourne",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const heading = location.pathname.startsWith("/analytics/")
    ? { eyebrow: "Post performance", title: "Analytics detail" }
    : location.pathname === "/analytics"
      ? {
          eyebrow: today,
          title: demoMode ? "Good morning, Adeel" : "Performance overview",
        }
      : location.pathname === "/calendar"
        ? { ...baseHeading, eyebrow: "Australia/Melbourne" }
        : baseHeading;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/analytics" className="brand" aria-label="Postline home">
          <span className="brand-mark">P</span>
          <span className="brand-word">postline</span>
        </NavLink>

        <NavLink to="/composer" className="create-button">
          <Plus size={18} />
          Create post
          <span className="shortcut">C</span>
        </NavLink>

        <nav aria-label="Main navigation">
          <NavigationGroup
            items={primaryNavigation}
            showDemoCounts={demoMode}
          />
          <NavigationGroup
            label="CONTENT"
            items={contentNavigation}
            showDemoCounts={demoMode}
          />
          <NavigationGroup
            label="WORKSPACE"
            items={settingsNavigation}
            showDemoCounts={demoMode}
          />
        </nav>

        <div className="sidebar-bottom">
          <a
            href="https://github.com/adeel1608/social-media-scheduler#readme"
            target="_blank"
            rel="noreferrer"
            className="nav-item"
          >
            <CircleHelp size={18} />
            <span>Documentation</span>
          </a>
          <button
            className="profile-row"
            onClick={() => void signOut()}
            aria-label="Sign out"
          >
            <span className="avatar">AD</span>
            <span className="profile-copy">
              <strong>{demoMode ? "Adeel" : "Installation owner"}</strong>
              <small>
                {demoMode ? "Local demonstration" : session?.user.email}
              </small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div>
            <p className="eyebrow">{heading.eyebrow}</p>
            <h1>{heading.title}</h1>
          </div>
          <div className="topbar-actions">
            {demoMode && (
              <span className="demo-pill">
                <Sparkles size={14} /> Demo data — no publishing
              </span>
            )}
            <span className="timezone-pill">
              <Clock3 size={15} /> Melbourne time
            </span>
          </div>
        </header>
        <div className="page-wrap">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
