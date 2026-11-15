import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/layout/Shell";
import { useAudioService } from "./hooks/useAudioService";
import { useMonitor } from "./hooks/useMonitor";
import { OverviewPage } from "./pages/OverviewPage";
import { LivePage } from "./pages/LivePage";
import { SessionsPage } from "./pages/SessionsPage";
import { SetupPage } from "./pages/SetupPage";
import { AboutPage } from "./pages/AboutPage";

export default function App() {
  const audio = useAudioService();
  const monitor = useMonitor();
  const demo = monitor.mode === "demo";

  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={
            <Shell
              mode={monitor.mode}
              onMode={(m) => void monitor.setMode(m)}
              demo={demo}
              wsOk={monitor.connection === "open"}
              monitoring={monitor.session?.monitoring ?? false}
            />
          }
        >
          <Route index element={<OverviewPage monitor={monitor} audio={audio} />} />
          <Route path="live" element={<LivePage monitor={monitor} audio={audio} />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="setup" element={<SetupPage audio={audio} />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
