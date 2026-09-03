import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { useAuth } from "./context/AuthContext";
import { AccountsPage } from "./pages/AccountsPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { PostAnalyticsPage } from "./pages/PostAnalyticsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { ComposerPage } from "./pages/ComposerPage";
import { FailedPage } from "./pages/FailedPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LegalPage } from "./pages/LegalPage";
import { LoginPage } from "./pages/LoginPage";
import { QueuePage } from "./pages/QueuePage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";

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
  );
}
