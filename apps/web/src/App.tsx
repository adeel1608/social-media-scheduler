import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { useAuth } from "./context/AuthContext";
import { LegalPage } from "./pages/LegalPage";
import { LoginPage } from "./pages/LoginPage";

const AccountsPage = lazy(() =>
  import("./pages/AccountsPage").then((module) => ({
    default: module.AccountsPage,
  })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/AnalyticsPage").then((module) => ({
    default: module.AnalyticsPage,
  })),
);
const PostAnalyticsPage = lazy(() =>
  import("./pages/PostAnalyticsPage").then((module) => ({
    default: module.PostAnalyticsPage,
  })),
);
const CalendarPage = lazy(() =>
  import("./pages/CalendarPage").then((module) => ({
    default: module.CalendarPage,
  })),
);
const ComposerPage = lazy(() =>
  import("./pages/ComposerPage").then((module) => ({
    default: module.ComposerPage,
  })),
);
const FailedPage = lazy(() =>
  import("./pages/FailedPage").then((module) => ({
    default: module.FailedPage,
  })),
);
const HistoryPage = lazy(() =>
  import("./pages/HistoryPage").then((module) => ({
    default: module.HistoryPage,
  })),
);
const QueuePage = lazy(() =>
  import("./pages/QueuePage").then((module) => ({
    default: module.QueuePage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const SetupPage = lazy(() =>
  import("./pages/SetupPage").then((module) => ({
    default: module.SetupPage,
  })),
);

function ProtectedApp() {
  const { session, demoMode, loading } = useAuth();
  if (loading)
    return (
      <div className="app-loader">
        <span className="brand-mark">P</span>
        <span>Securing your workspace…</span>
      </div>
    );
  if (!session && !demoMode) return <Navigate to="/login" replace />;
  return <AppShell />;
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="app-loader" role="status" aria-live="polite">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>Loading workspace...</span>
        </div>
      }
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/privacy" element={<LegalPage type="privacy" />} />
        <Route path="/terms" element={<LegalPage type="terms" />} />
        <Route path="/data-deletion" element={<LegalPage type="deletion" />} />
        <Route element={<ProtectedApp />}>
          <Route index element={<Navigate to="/analytics" replace />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/analytics/:targetId" element={<PostAnalyticsPage />} />
          <Route path="/composer" element={<ComposerPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/failed" element={<FailedPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/analytics" replace />} />
      </Routes>
    </Suspense>
  );
}
