import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { useSession } from './lib/session';
import DraftPage from './pages/DraftPage';
import JoinPage from './pages/JoinPage';
import LeagueHomePage from './pages/LeagueHomePage';
import LeaguesPage from './pages/LeaguesPage';
import LoginPage from './pages/LoginPage';
import NewsPage from './pages/NewsPage';
import RosterPage from './pages/RosterPage';
import ScoreboardPage from './pages/ScoreboardPage';
import SettingsPage from './pages/SettingsPage';
import StandingsPage from './pages/StandingsPage';
import TradePage from './pages/TradePage';
import ValuationPage from './pages/ValuationPage';
import WaiversPage from './pages/WaiversPage';

export default function App() {
  const { user, loading } = useSession();

  if (loading) return <Spinner label="Signing you in" />;

  if (!user) {
    return (
      <Routes>
        <Route path="/join" element={<JoinPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<LeaguesPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/leagues/:leagueId" element={<Layout />}>
        <Route index element={<LeagueHomePage />} />
        <Route path="roster" element={<RosterRedirect />} />
        <Route path="teams/:teamId" element={<RosterPage />} />
        <Route path="trade" element={<TradePage />} />
        <Route path="waivers" element={<WaiversPage />} />
        <Route path="scoreboard" element={<ScoreboardPage />} />
        <Route path="standings" element={<StandingsPage />} />
        <Route path="draft" element={<DraftPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="values" element={<ValuationPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** "My roster" resolves to whichever team the signed-in user owns here. */
function RosterRedirect() {
  const { leagueId } = useParams();
  const { leagues } = useSession();
  const league = leagues.find((l) => l.id === leagueId);

  if (!league?.team_id) return <Navigate to={`/leagues/${leagueId}`} replace />;
  return <Navigate to={`/leagues/${leagueId}/teams/${league.team_id}`} replace />;
}
