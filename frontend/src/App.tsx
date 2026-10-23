import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { useMe } from "./api/queries";
import type { Me } from "./api/types";
import { CalculatorPage } from "./calculator/CalculatorPage";
import type { OverlayState } from "./components/UserMenu";
import { LibraryPage } from "./library/LibraryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsOverlay } from "./pages/SettingsOverlay";
import { WelcomePage } from "./pages/WelcomePage";

const SETTINGS_PATH = "/settings";

function welcomePath(location: { pathname: string; search: string }) {
  return `/welcome?${new URLSearchParams({ next: location.pathname + location.search })}`;
}

function RequireHandle({ me }: { me: Me }) {
  const location = useLocation();
  if (!me.handle) return <Navigate to={welcomePath(location)} replace />;
  return <Outlet />;
}

function useSingleAccountAcrossTabs(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    const channel = new BroadcastChannel("math-account");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== userId) location.reload();
    };
    channel.postMessage(userId);
    return () => channel.close();
  }, [userId]);
}

export function App() {
  const me = useMe();
  useSingleAccountAcrossTabs(me.data?.id);
  const location = useLocation();
  if (!me.data) return null;

  const background = (location.state as OverlayState | null)?.backgroundLocation;
  const settingsOpen = location.pathname === SETTINGS_PATH;
  const pageLocation = background ?? (settingsOpen ? { ...location, pathname: "/", search: "" } : location);

  return (
    <>
      <Routes location={pageLocation}>
        <Route path="/welcome" element={<WelcomePage me={me.data} />} />
        <Route element={<RequireHandle me={me.data} />}>
          <Route element={<LibraryPage />}>
            <Route index element={null} />
            <Route path="folders/:folderId" element={null} />
            <Route path="shared" element={null} />
          </Route>
          <Route path="calculator/:graphId" element={<CalculatorPage />} />
          <Route path="profile/:handle" element={<ProfilePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {settingsOpen &&
        (me.data.handle ? <SettingsOverlay me={me.data} /> : <Navigate to={welcomePath(location)} replace />)}
    </>
  );
}
