import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  Ellipsis, FileCode2, FileSpreadsheet, FileText, Link2, Pencil, QrCode, ScanFace, Undo2, UserCheck, Users,
} from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { eventApi, reportApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import Layout from '../../components/layout/Layout';
import Button, { IconButton, OutlineIconButton } from '../../components/ui/Button';
import { AttendanceBadge, PhaseBadge } from '../../components/ui/Badge';
import Modal, { useConfirm } from '../../components/ui/Modal';
import Tabs from '../../components/ui/Tabs';
import Select from '../../components/ui/Select';
import Pagination from '../../components/ui/Pagination';
import Dropdown, { MenuGroup, MenuItem } from '../../components/ui/Dropdown';
import { Card, StatGrid, TableCard, Th } from '../../components/ui/Card';
import { Field, Input, SearchInput } from '../../components/ui/Input';
import { EmptyText, Skeleton, SkeletonRows } from '../../components/ui/States';
import { eventPhase, longDate, timeRange } from '../../utils/eventStatus';
import { cx } from '../../utils/cx';
import EventEditModal from './EventEditModal';
import EventMembersModal from './EventMembersModal';
import ReportViewerModal from './ReportViewerModal';
import EventFeedbackPanel from './EventFeedbackPanel';
import EventReminderPanel from './EventReminderPanel';
import EventCertificatePanel from './EventCertificatePanel';
import InvitationEventDetail from './invitation/InvitationEventDetail';
import PublicEventDetail from './public/PublicEventDetail';
import GateRow from './GateRow';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'Tất cả' },
  { value: 'REGISTERED', label: 'Đã đăng ký' },
  { value: 'CHECKED_IN', label: 'Đã check-in' },
  { value: 'CHECKED_OUT', label: 'Đã check-out' },
  { value: 'ABSENT', label: 'Vắng' },
];

export default function EventDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const [event, setEvent] = useState(null);
  const [attendances, setAttendances] = useState([]);
  const [stats, setStats] = useState({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [gateLoading, setGateLoading] = useState(null); // 'checkin' | 'checkout' | null
  const [manualModal, setManualModal] = useState(false);
  const [manualUser, setManualUser] = useState('');
  const [manualType, setManualType] = useState('checkin');
  const [editModal, setEditModal] = useState(false);
  const [membersModal, setMembersModal] = useState(false);
  const [reportModal, setReportModal] = useState(false);
  const [tab, setTab] = useState('attendance');
  const [unavailable, setUnavailable] = useState({}); // tab bị 403 thì ẩn

  const canProject = ['ADMIN', 'BTC'].includes(user?.role);

  const reloadEvent = () => eventApi.get(id).then(({ data }) => setEvent(data.data));

  const loadAttendance = useCallback((p = page) => {
    eventApi.getAttendance(id, { search, status: statusFilter, page: p, limit: PAGE_SIZE })
      .then(({ data }) => {
        setAttendances(data.data || []);
        setStats(data.stats || {});
        setTotal(data.total || 0);
      });
  }, [id, search, statusFilter, page]);

  useEffect(() => {
    Promise.all([
      eventApi.get(id),
      eventApi.getAttendance(id, { page: 1, limit: PAGE_SIZE }),
    ]).then(([eventRes, attRes]) => {
      setEvent(eventRes.data.data);
      setAttendances(attRes.data.data || []);
      setStats(attRes.data.stats || {});
      setTotal(attRes.data.total || 0);
    }).finally(() => setLoading(false));
  }, [id]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
    loadAttendance(1);
  }, [search, statusFilter]); // eslint-disable-line

  // Auto-refresh every 15s (sự kiện thiệp mời có trang riêng, không có bảng điểm danh)
  useEffect(() => {
    if (event?.kind === 'INVITATION' || event?.kind === 'PUBLIC') return undefined;
    const timer = setInterval(() => loadAttendance(page), 15000);
    return () => clearInterval(timer);
  }, [loadAttendance, page, event?.kind]);

  // Mở thẳng modal sửa khi tới từ menu "Sửa sự kiện" ở danh sách (?edit=1)
  useEffect(() => {
    if (!event || searchParams.get('edit') !== '1') return;
    setEditModal(true);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps

  const goToPage = (p) => {
    setPage(p);
    loadAttendance(p);
  };

  const downloadBlob = (data, mime, filename) => {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { data } = await reportApi.exportAttendance(id);
      downloadBlob(data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `diemdanh-${event.name}.xlsx`);
    } catch {
      toast.error('Xuất báo cáo thất bại');
    } finally {
      setExporting(false);
    }
  };

  const handleExportHtml = async () => {
    setExportingHtml(true);
    try {
      const { data } = await reportApi.exportAttendanceHtml(id);
      downloadBlob(data, 'text/html', `baocao-${event.name}.html`);
    } catch {
      toast.error('Xuất báo cáo thất bại');
    } finally {
      setExportingHtml(false);
    }
  };

  // Ba nấc của mỗi cổng: Theo lịch (AUTO) · Mở (OPEN) · Đóng (CLOSED). Mở/Đóng ghi đè hoàn
  // toàn khung giờ đã đặt; Theo lịch trả cổng về chạy theo khung giờ.
  const handleSetGate = async (type, state) => {
    setGateLoading(type);
    try {
      const field = type === 'checkin' ? 'checkinState' : 'checkoutState';
      const { data } = await eventApi.update(id, { [field]: state });
      setEvent((e) => ({ ...e, [field]: data.data[field], gate: data.data.gate }));
      const target = type === 'checkin' ? 'điểm danh' : 'check-out';
      toast.success(
        state === 'OPEN' ? `Đã mở ${target}`
          : state === 'CLOSED' ? `Đã đóng ${target}`
            : `${type === 'checkin' ? 'Điểm danh' : 'Check-out'} chạy theo lịch`
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thao tác thất bại');
    } finally {
      setGateLoading(null);
    }
  };

  // Link công khai để BTC phát cho sinh viên tự đăng ký tham gia.
  const registrationUrl = `${window.location.origin}/dang-ky/${id}`;

  const handleCopyRegistrationLink = async () => {
    try {
      await navigator.clipboard.writeText(registrationUrl);
      toast.success('Đã copy link đăng ký');
    } catch {
      // clipboard API cần HTTPS/quyền — hiện link để BTC copy tay.
      toast(registrationUrl, { duration: 8000 });
    }
  };

  const handleManualCheckin = async (e) => {
    e?.preventDefault();
    if (!manualUser.trim()) return toast.error('Nhập MSSV hoặc Email sinh viên');
    try {
      await eventApi.manualCheckin(id, { identifier: manualUser, type: manualType });
      toast.success('Check-in thủ công thành công');
      setManualModal(false);
      setManualUser('');
      loadAttendance(page);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thất bại');
    }
  };

  // Gỡ nhầm lượt check-in (bấm nhầm, kiosk nhận nhầm mặt, quét hộ): người đó về "Đã đăng ký"
  // và có thể check-in lại. Server giữ nguyên dòng điểm danh, chỉ xoá giờ vào/ra.
  const handleUndoCheckin = async (att) => {
    if (!(await confirm({
      title: 'Gỡ lượt check-in?',
      body: (
        <>
          <span className="font-medium text-foreground">{att.user.name}</span> sẽ trở về trạng thái “Đã đăng ký”
          {att.checkoutTime ? ', lượt check-out cũng bị gỡ' : ''}. Người này có thể check-in lại.
        </>
      ),
      confirmLabel: 'Gỡ check-in',
      icon: Undo2,
    }))) return;
    try {
      await eventApi.undoCheckin(id, att.userId || att.user.id);
      toast.success(`Đã gỡ check-in của ${att.user.name}`);
      loadAttendance(page);
      reloadEvent();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Gỡ check-in thất bại');
    }
  };

  const undoButton = (att) => (canProject && att.checkinTime ? (
    <IconButton icon={Undo2} label={`Gỡ check-in của ${att.user.name}`} danger row onClick={() => handleUndoCheckin(att)} />
  ) : null);

  const shell = (content) => (
    <Layout parent={{ label: 'Sự kiện', to: '/events' }} activeNav="/events">{content}</Layout>
  );

  if (loading) {
    return shell(
      <div aria-busy="true">
        <div className="mb-6 space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-1/3" /></div>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-4 rounded-2xl border border-border bg-surface p-5"><Skeleton className="h-4 w-32" /><Skeleton className="h-10 w-full rounded-xl" /><Skeleton className="h-10 w-full rounded-xl" /></div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-border sm:grid-cols-4 xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="space-y-3 bg-surface p-5"><Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-12" /></div>)}
          </div>
        </div>
        <TableCard className="mt-6"><SkeletonRows rows={6} /></TableCard>
      </div>,
    );
  }

  if (!event) {
    return shell(
      <div className="mx-auto max-w-md pb-16 pt-16 text-center sm:pt-24">
        <p className="text-sm font-medium tabular-nums text-muted">404</p>
        <h1 className="mt-1 text-xl font-semibold text-foreground">Không tìm thấy sự kiện</h1>
        <p className="mt-2 text-pretty text-sm/6 text-muted">Sự kiện có thể đã bị xoá, hoặc đường dẫn bị gõ sai.</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button as={Link} to="/events" variant="primary" size="form">Về danh sách sự kiện</Button>
        </div>
      </div>,
    );
  }

  // Check-in công khai: QR cố định + form tự điền — trang quản lý riêng.
  if (event.kind === 'PUBLIC') {
    return shell(
      <>
        <PublicEventDetail event={event} onEdit={() => setEditModal(true)} onGateChange={handleSetGate} gateLoading={gateLoading} />
        <EventEditModal open={editModal} event={event} onClose={() => setEditModal(false)} onSaved={reloadEvent} />
      </>,
    );
  }

  // Sự kiện thiệp mời: khách ngoài + quét thiệp — trang quản lý riêng.
  if (event.kind === 'INVITATION') {
    return shell(
      <>
        <InvitationEventDetail event={event} onEventChanged={reloadEvent} />
        {/* Mở thẳng từ menu "Sửa sự kiện" ở danh sách (?edit=1) */}
        <EventEditModal open={editModal} event={event} onClose={() => setEditModal(false)} onSaved={reloadEvent} />
      </>,
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const phase = eventPhase(event);
  const when = event.checkinOpen ? `${longDate(event.checkinOpen)} · ${timeRange(event)}` : 'Chưa đặt lịch';

  const checkedPct = stats.total ? Math.round(((stats.checkedIn || 0) / stats.total) * 100) : 0;
  const checkoutNote = event.gate?.checkout?.reason === 'NOT_STARTED' && event.checkoutOpen
    ? `Check-out mở lúc ${format(new Date(event.checkoutOpen), 'HH:mm')}` : undefined;

  const hideTab = (key) => setUnavailable((u) => ({ ...u, [key]: true }));
  const tabs = [
    { value: 'attendance', label: 'Điểm danh', count: stats.total || 0 },
    !unavailable.reminders && { value: 'reminders', label: 'Nhắc lịch' },
    !unavailable.feedback && { value: 'feedback', label: 'Đánh giá' },
    !unavailable.certificate && { value: 'certificate', label: 'Chứng nhận' },
  ].filter(Boolean);

  return shell(
    <>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-balance text-lg font-semibold text-foreground">{event.name}</h1>
          <div className="mt-2 flex flex-col items-start gap-2 text-sm text-muted sm:flex-row sm:items-center sm:gap-3">
            <PhaseBadge phase={phase} />
            <span>{when}</span>
          </div>
          <p className="mt-2 max-w-[55ch] text-pretty text-sm/6 text-muted">{event.location}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canProject && (
            <Button as="a" href={`/events/${id}/qr`} target="_blank" rel="noopener noreferrer" variant="primary" icon={QrCode}>Mở màn QR</Button>
          )}
          <Button icon={FileText} onClick={() => setReportModal(true)}>Báo cáo</Button>
          <Dropdown align="end" ariaLabel="Thêm thao tác" trigger={<OutlineIconButton icon={Ellipsis} label="Thêm thao tác" />}>
            <MenuGroup>
              <MenuItem icon={Pencil} onSelect={() => setEditModal(true)}>Sửa sự kiện</MenuItem>
              {canProject && (
                <MenuItem icon={ScanFace} onSelect={() => window.open(`/events/${id}/face-checkin`, '_blank', 'noopener')}>
                  Kiosk check-in khuôn mặt
                </MenuItem>
              )}
              {event.allowRegistration !== false && (
                <MenuItem icon={Link2} onSelect={handleCopyRegistrationLink}>Sao chép link đăng ký</MenuItem>
              )}
              <MenuItem icon={FileSpreadsheet} disabled={exporting} onSelect={handleExport}>Tải file Excel</MenuItem>
              <MenuItem icon={FileCode2} disabled={exportingHtml} onSelect={handleExportHtml}>Tải file HTML</MenuItem>
            </MenuGroup>
          </Dropdown>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Cổng điểm danh">
          <div className="divide-y divide-border">
            <GateRow
              label="Check-in"
              gate={event.gate?.checkin}
              state={event.checkinState}
              openAt={event.checkinOpen}
              closeAt={event.checkinClose}
              loading={gateLoading === 'checkin'}
              onChange={(state) => handleSetGate('checkin', state)}
            />
            <GateRow
              label="Check-out"
              gate={event.gate?.checkout}
              state={event.checkoutState}
              openAt={event.checkoutOpen}
              closeAt={event.checkoutClose}
              loading={gateLoading === 'checkout'}
              onChange={(state) => handleSetGate('checkout', state)}
            />
          </div>
        </Card>
        <StatGrid
          cols="grid-cols-2 sm:grid-cols-4 xl:grid-cols-2"
          tiles={[
            { label: 'Đăng ký', value: stats.total || 0 },
            { label: 'Đã check-in', value: stats.checkedIn || 0, sub: stats.total ? `${checkedPct}% số đăng ký` : undefined },
            { label: 'Đã check-out', value: stats.checkedOut || 0, sub: checkoutNote },
            {
              label: 'Chưa check-in',
              value: stats.registered || 0,
              sub: event.gate?.checkin?.open && stats.registered > 0 ? 'Cổng vẫn đang mở' : undefined,
              subTone: 'warning',
            },
          ]}
        />
      </div>

      <div className="mb-4 mt-6">
        <Tabs variant="underline" ariaLabel="Nội dung sự kiện" items={tabs} value={tab} onChange={setTab} />
      </div>

      <div hidden={tab !== 'attendance'}>
        <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput className="w-full sm:w-64" placeholder="Tìm theo tên, MSSV" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select inline label="Trạng thái:" aria-label="Lọc theo trạng thái" value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex xl:ml-auto">
            <Button icon={UserCheck} iconClassName="hidden size-4 shrink-0 sm:block" onClick={() => setManualModal(true)}>Check-in thủ công</Button>
            <Button icon={Users} iconClassName="hidden size-4 shrink-0 sm:block" onClick={() => setMembersModal(true)}>Danh sách tham gia</Button>
          </div>
        </div>
        <TableCard>
          {attendances.length === 0 ? (
            <EmptyText className="py-10">
              {search || statusFilter ? 'Không có ai khớp bộ lọc.' : 'Chưa có ai trong danh sách tham gia.'}
            </EmptyText>
          ) : (
            <>
              <table className="hidden w-full text-sm sm:table">
                <thead className="border-b border-border">
                  <tr>
                    <Th className="w-full">Sinh viên</Th>
                    <Th>Lớp</Th>
                    <Th>Check-in</Th>
                    <Th>Check-out</Th>
                    <Th>Trạng thái</Th>
                    {canProject && <th className="w-px px-2"><span className="sr-only">Thao tác</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {attendances.map((att) => (
                    <tr key={att.id} className="border-b border-border last:border-0">
                      <td className="max-w-0 px-4 py-3">
                        <p className="truncate font-medium text-foreground" title={att.user.name}>{att.user.name}</p>
                        <p className="mt-0.5 text-xs tabular-nums text-muted">{att.user.mssv || att.user.email}</p>
                      </td>
                      <td className={cx('whitespace-nowrap px-4 py-3', att.user.class ? 'text-foreground' : 'text-muted')}>{att.user.class || '—'}</td>
                      <td className={cx('whitespace-nowrap px-4 py-3 tabular-nums', att.checkinTime ? 'text-foreground' : 'text-muted')}>
                        {att.checkinTime ? format(new Date(att.checkinTime), 'HH:mm:ss') : '—'}
                      </td>
                      <td className={cx('whitespace-nowrap px-4 py-3 tabular-nums', att.checkoutTime ? 'text-foreground' : 'text-muted')}>
                        {att.checkoutTime ? format(new Date(att.checkoutTime), 'HH:mm:ss') : '—'}
                      </td>
                      <td className="px-4 py-3"><AttendanceBadge status={att.status} /></td>
                      {canProject && <td className="px-2 py-3">{undoButton(att)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="divide-y divide-border sm:hidden">
                {attendances.map((att) => (
                  <li key={att.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{att.user.name}</p>
                        <p className="mt-0.5 text-xs tabular-nums text-muted">
                          {att.user.mssv || att.user.email}{att.user.class ? ` · ${att.user.class}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <AttendanceBadge status={att.status} />
                        {undoButton(att)}
                      </div>
                    </div>
                    {att.checkinTime && (
                      <p className="mt-1 text-xs tabular-nums text-muted">
                        Vào {format(new Date(att.checkinTime), 'HH:mm:ss')}
                        {att.checkoutTime && ` · Ra ${format(new Date(att.checkoutTime), 'HH:mm:ss')}`}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <Pagination
                compact
                page={page}
                pages={totalPages}
                total={total}
                pageSize={PAGE_SIZE}
                noun="người"
                note="tự cập nhật mỗi 15 giây"
                onPageChange={goToPage}
              />
            </>
          )}
        </TableCard>
      </div>

      <div hidden={tab !== 'reminders'}>
        <EventReminderPanel event={event} onUnavailable={() => hideTab('reminders')} />
      </div>
      <div hidden={tab !== 'feedback'}>
        <EventFeedbackPanel eventId={id} eventName={event.name} onUnavailable={() => hideTab('feedback')} />
      </div>
      <div hidden={tab !== 'certificate'}>
        <EventCertificatePanel event={event} onUnavailable={() => hideTab('certificate')} />
      </div>

      {/* Check-in thủ công */}
      <Modal
        open={manualModal}
        onClose={() => setManualModal(false)}
        title="Check-in thủ công"
        description="Dùng khi sinh viên không thể quét QR (hết pin, lỗi GPS...)"
        size="sm"
        footer={(
          <>
            <Button variant="secondary" size="form" onClick={() => setManualModal(false)}>Huỷ</Button>
            <Button type="submit" form="manual-checkin-form" variant="primary" size="form">Xác nhận</Button>
          </>
        )}
      >
        <form id="manual-checkin-form" onSubmit={handleManualCheckin} className="flex flex-col gap-5">
          <Field label="MSSV hoặc Email sinh viên">
            {(fid) => (
              <Input id={fid} placeholder="SE123456 hoặc email@fpt.edu.vn" value={manualUser} onChange={(e) => setManualUser(e.target.value)} />
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">Loại</p>
            <Tabs
              variant="segmented"
              layout="full"
              ariaLabel="Loại điểm danh"
              value={manualType}
              onChange={setManualType}
              items={[{ value: 'checkin', label: 'Check-in', grow: true }, { value: 'checkout', label: 'Check-out', grow: true }]}
            />
          </div>
        </form>
      </Modal>

      <EventEditModal open={editModal} event={event} onClose={() => setEditModal(false)} onSaved={reloadEvent} />

      <EventMembersModal
        open={membersModal}
        eventId={id}
        onClose={() => setMembersModal(false)}
        onChanged={() => { reloadEvent(); loadAttendance(page); }}
      />

      {/* Xem báo cáo HTML ngay trên web (kèm nút tải file / in PDF bên trong) */}
      <ReportViewerModal open={reportModal} eventId={id} eventName={event.name} onClose={() => setReportModal(false)} />
    </>,
  );
}
