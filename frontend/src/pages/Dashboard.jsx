import { useState, useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { CircleCheck, ListChecks, MessageSquareText, Plus, QrCode, ScanLine, TicketCheck } from 'lucide-react';
import { eventApi, adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import Layout from '../components/layout/Layout';
import Button, { viewAllClass } from '../components/ui/Button';
import Badge, { AttendanceBadge, PhaseBadge } from '../components/ui/Badge';
import { Card, DateTile, StatGrid } from '../components/ui/Card';
import { EmptyText, LoadError, Skeleton, SkeletonRows } from '../components/ui/States';
import { eventPhase, formatNumber, gateNote, isGateOpen, shortDate, timeRange } from '../utils/eventStatus';

// Tổng quan cho nhân sự. Người tham gia không có tài khoản (spec
// 2026-11-07-participant-lists-design.md) nên không còn trang chủ sinh viên;
// giảng viên vào thẳng danh sách sự kiện.
export default function Dashboard() {
  const { user } = useAuth();
  const isAdminOrBtc = ['ADMIN', 'BTC'].includes(user?.role);

  const [events,    setEvents]    = useState([]);
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchAll = async () => {
    setLoadError(false);
    setLoading(true);
    try {
      // /api/admin/stats chỉ dành cho ADMIN — BTC không có số liệu toàn hệ thống, không phải lỗi.
      const [eventsRes, statsRes] = await Promise.all([
        eventApi.list({ limit: 20 }),
        adminApi.getStats().catch(() => null),
      ]);
      setEvents(eventsRes.data.data || []);
      setStats(statsRes?.data.data || null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (isAdminOrBtc) fetchAll(); }, [isAdminOrBtc]);

  if (!isAdminOrBtc) return <Navigate to="/events" replace />;
  return <StaffOverview events={events} stats={stats} loading={loading} loadError={loadError} onRetry={fetchAll} />;
}

/* ─────────────────────────────────────── */

function SectionTitle({ children }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-foreground">{children}</h2>
    </div>
  );
}

const registeredCount = (e) => e._count?.eventMembers ?? e._count?.attendances ?? 0;
const metaLine = (e, phase) => [phase === 'manual' ? 'Chưa đặt lịch' : timeRange(e), e.location].filter(Boolean).join(' · ');
// Dòng giờ của thẻ đang diễn ra: không đặt lịch mà cổng đang mở tay thì ghi "Mở thủ công"
const liveTimeLine = (e) => [timeRange(e) || 'Mở thủ công', e.location].filter(Boolean).join(' · ');

// Sự kiện sắp tới lên trước, sự kiện chưa đặt lịch xuống cuối
const bySoonest = (a, b) => {
  if (!a.checkinOpen) return 1;
  if (!b.checkinOpen) return -1;
  return new Date(a.checkinOpen) - new Date(b.checkinOpen);
};

/* ───────────── Tổng quan: Ban tổ chức, Admin ───────────── */

// Thẻ sự kiện đang diễn ra. checkedIn/registered (số đã check-in) chưa có trong API danh sách:
// truyền vào thì thẻ hiện thanh tiến độ (dữ liệu có ở GET /events/:id/live).
function LiveCard({ event, checkedIn }) {
  const registered = registeredCount(event);
  const hasProgress = typeof checkedIn === 'number' && registered > 0;
  const pct = hasProgress ? Math.round((checkedIn / registered) * 100) : 0;
  const note = gateNote(event);
  return (
    <article className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PhaseBadge phase="live" />
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <h3 className="mt-3 text-pretty text-base font-semibold text-foreground">
        <Link to={`/events/${event.id}`} className="outline-none hover:underline">{event.name}</Link>
      </h3>
      <p className="mt-1 text-pretty text-sm text-muted">{liveTimeLine(event)}</p>
      {hasProgress && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium tabular-nums text-foreground">{formatNumber(checkedIn)} / {formatNumber(registered)} đã check-in</p>
            <p className="text-sm tabular-nums text-muted">{pct}%</p>
          </div>
          <div className="mt-2 h-2 rounded-full bg-foreground/5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Đã check-in">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          {registered - checkedIn > 0 && (
            <p className="mt-2 text-xs text-muted">
              <span className="font-medium text-warning">{formatNumber(registered - checkedIn)} người chưa check-in</span>
            </p>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button as="a" href={`/events/${event.id}/qr`} target="_blank" rel="noopener noreferrer" variant="primary" icon={QrCode}>Mở màn QR</Button>
        <Button as={Link} to={`/events/${event.id}`} icon={ListChecks}>Xem điểm danh</Button>
      </div>
    </article>
  );
}

function EventRow({ event }) {
  const phase = eventPhase(event);
  const registered = registeredCount(event);
  return (
    <li>
      <Link to={`/events/${event.id}`} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 outline-none hover:bg-item-hover">
        <DateTile date={event.checkinOpen} live={phase === 'live'} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={event.name}>{event.name}</p>
          <p className="mt-1 truncate text-xs text-muted">{metaLine(event, phase)}</p>
        </div>
        <span className="hidden shrink-0 text-sm tabular-nums text-muted sm:inline">
          {registered ? `${formatNumber(registered)} đăng ký` : 'Chưa có ai đăng ký'}
        </span>
      </Link>
    </li>
  );
}

function StaffOverview({ events, stats, loading, loadError, onRetry }) {
  const live = events.filter((e) => eventPhase(e) === 'live');
  const upcoming = events.filter((e) => ['upcoming', 'manual'].includes(eventPhase(e))).sort(bySoonest).slice(0, 6);
  const ended = events.filter((e) => eventPhase(e) === 'ended').slice(0, 4);
  const isEmpty = !loading && !loadError && events.length === 0;

  const createButton = !isEmpty && (
    <Button as={Link} to="/events/new" variant="primary" size="hdr" icon={Plus}>Tạo sự kiện</Button>
  );

  let content;
  if (loadError) {
    content = (
      <div className="rounded-2xl border border-border bg-surface">
        <LoadError title="Không tải được tổng quan" onRetry={onRetry} />
      </div>
    );
  } else if (isEmpty) {
    content = (
      <section className="max-w-xl rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-foreground">Tạo sự kiện đầu tiên</h2>
        <p className="mt-2 text-pretty text-sm/6 text-muted">
          Sự kiện có mã QR đổi mỗi 30 giây, sinh viên quét bằng camera điện thoại để điểm danh. Tạo xong là chiếu được ngay.
        </p>
        <div className="mt-4">
          <Button as={Link} to="/events/new" variant="primary" icon={Plus}>Tạo sự kiện</Button>
        </div>
      </section>
    );
  } else {
    content = (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <section>
            <SectionTitle>Đang diễn ra</SectionTitle>
            {loading ? (
              <div className="space-y-3 rounded-2xl border border-border bg-surface p-5">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-2 w-full" />
              </div>
            ) : live.length ? (
              <div className="grid gap-3">{live.map((e) => <LiveCard key={e.id} event={e} />)}</div>
            ) : (
              <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Hiện không có sự kiện nào đang diễn ra.</p>
            )}
          </section>
          <Card title="Sắp diễn ra" action={<Link to="/events" className={viewAllClass()}>Xem tất cả</Link>} flush>
            {loading ? <SkeletonRows rows={4} /> : upcoming.length ? (
              <ul className="flex flex-col gap-0.5">{upcoming.map((e) => <EventRow key={e.id} event={e} />)}</ul>
            ) : (
              <EmptyText>Không có sự kiện sắp tới.</EmptyText>
            )}
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <p className="mb-2 text-xs text-muted">Toàn hệ thống</p>
            <StatGrid
              cols="grid-cols-2"
              small
              tiles={[
                { label: 'Người dùng', value: stats ? formatNumber(stats.totalUsers) : '—' },
                { label: 'Người tham gia', value: stats ? formatNumber(stats.totalStudents) : '—' },
                { label: 'Sự kiện đang mở', value: stats ? formatNumber(stats.totalEvents) : '—' },
                { label: 'Lượt điểm danh', value: stats ? formatNumber(stats.totalCheckins) : '—' },
              ]}
            />
          </div>
          <Card title="Đã kết thúc gần đây" action={<Link to="/events" className={viewAllClass()}>Xem tất cả</Link>} flush>
            {loading ? <SkeletonRows rows={3} avatar={false} right={false} /> : ended.length ? (
              <ul className="flex flex-col gap-0.5">
                {ended.map((e) => (
                  <li key={e.id}>
                    <Link to={`/events/${e.id}`} className="flex flex-col gap-1 rounded-xl px-3 py-2.5 outline-none hover:bg-item-hover">
                      <span className="truncate text-sm font-medium text-foreground">{e.name}</span>
                      <span className="text-xs tabular-nums text-muted">
                        {shortDate(e.checkinOpen)} · {formatNumber(registeredCount(e))} đăng ký
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyText>Chưa có sự kiện nào kết thúc.</EmptyText>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return <Layout title="Tổng quan" headerRight={createButton}>{content}</Layout>;
}
