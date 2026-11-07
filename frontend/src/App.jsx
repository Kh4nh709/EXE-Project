import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { PageSpinner } from './components/ui/States';

// Pages
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import EventList from './pages/btc/EventList';
import EventCreate from './pages/btc/EventCreate';
import EventDetail from './pages/btc/EventDetail';
import QRDisplay from './pages/btc/QRDisplay';
import ScanLanding from './pages/scan/ScanLanding';
import UserManagement from './pages/admin/UserManagement';
import FraudLogs from './pages/FraudLogs';
import PublicEventList from './pages/public/PublicEventList';
import EventRegister from './pages/public/EventRegister';
import SharedReport from './pages/public/SharedReport';
import ClassManagement from './pages/classes/ClassManagement';
import ClassDetail from './pages/classes/ClassDetail';
import FeedbackTemplates from './pages/feedback/FeedbackTemplates';
import CertificateView from './pages/public/CertificateView';
import GuestScanPage from './pages/btc/GuestScanPage';
import VolunteerScan from './pages/public/VolunteerScan';
import InvitationView from './pages/public/InvitationView';
import PublicCheckin from './pages/public/checkin/PublicCheckin';
import FaceCheckin from './pages/btc/FaceCheckin';

function RequireAuth({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <PageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}

function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageSpinner />;
  if (user) {
    const params = new URLSearchParams(location.search);
    const redirectTo = params.get('redirect') || '/dashboard';
    return <Navigate to={redirectTo} replace />;
  }
  return children;
}

function RootRoute() {
  const { user, loading } = useAuth();
  if (loading) return <PageSpinner />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <Landing />;
}

export default function App() {
  return (
    <Routes>
      {/* Landing */}
      <Route path="/" element={<RootRoute />} />

      {/* Auth */}
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />

      {/* Đăng ký tham gia sự kiện — công khai, không cần đăng nhập */}
      <Route path="/dang-ky" element={<PublicEventList />} />
      <Route path="/dang-ky/:id" element={<EventRegister />} />

      {/* Báo cáo BTC chia sẻ — xem được không cần đăng nhập */}
      <Route path="/bao-cao/:token" element={<SharedReport />} />
      {/* Link riêng trong email chứng nhận — không cần đăng nhập */}
      <Route path="/chung-nhan/:token" element={<CertificateView />} />

      {/* Sự kiện thiệp mời — công khai: khách xem thiệp của mình, tình nguyện viên quét qua link BTC phát */}
      <Route path="/thiep/:code" element={<InvitationView />} />
      <Route path="/quet/:token" element={<VolunteerScan />} />
      {/* Check-in công khai — người ghé thăm quét QR cố định trên màn chiếu, không cần tài khoản */}
      <Route path="/check-in/:id" element={<PublicCheckin />} />

      {/* Quét QR điểm danh — người tham gia không cần tài khoản (email + mã OTP) */}
      <Route path="/scan" element={<ScanLanding />} />

      {/* QR Display — requires BTC/ADMIN (opened in new tab) */}
      <Route path="/events/:id/qr" element={
        <RequireAuth roles={['ADMIN', 'BTC']}>
          <QRDisplay />
        </RequireAuth>
      } />

      {/* Quét thiệp mời ở cửa — BTC/ADMIN trên điện thoại */}
      <Route path="/events/:id/quet-thiep" element={
        <RequireAuth roles={['ADMIN', 'BTC']}>
          <GuestScanPage />
        </RequireAuth>
      } />

      {/* Kiosk check-in bằng khuôn mặt — laptop BTC ở cửa (mở ở tab mới) */}
      <Route path="/events/:id/face-checkin" element={
        <RequireAuth roles={['ADMIN', 'BTC']}>
          <FaceCheckin />
        </RequireAuth>
      } />

      {/* Tổng quan cho nhân sự. Người tham gia không có tài khoản nên không có trang riêng:
          họ check-in qua /scan, xem chứng nhận qua link trong email (/chung-nhan/:token). */}
      <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />

      {/* Events — BTC/ADMIN/LECTURER */}
      <Route path="/events" element={<RequireAuth roles={['ADMIN', 'BTC', 'LECTURER']}><EventList /></RequireAuth>} />
      <Route path="/events/new" element={<RequireAuth roles={['ADMIN', 'BTC']}><EventCreate /></RequireAuth>} />
      <Route path="/events/:id" element={<RequireAuth roles={['ADMIN', 'BTC', 'LECTURER']}><EventDetail /></RequireAuth>} />

      {/* Lớp học — BTC/Admin */}
      <Route path="/classes" element={<RequireAuth roles={['ADMIN', 'BTC']}><ClassManagement /></RequireAuth>} />
      <Route path="/classes/:id" element={<RequireAuth roles={['ADMIN', 'BTC']}><ClassDetail /></RequireAuth>} />

      {/* Thư viện mẫu đánh giá */}
      <Route path="/feedback-templates" element={<RequireAuth roles={['ADMIN', 'BTC']}><FeedbackTemplates /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin/users" element={<RequireAuth roles={['ADMIN']}><UserManagement /></RequireAuth>} />

      {/* Reports */}
      <Route path="/reports/fraud" element={<RequireAuth roles={['ADMIN', 'BTC']}><FraudLogs /></RequireAuth>} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
