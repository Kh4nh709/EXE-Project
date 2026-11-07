import { useState, useEffect, useCallback } from 'react';
import { GraduationCap, ScanFace, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { eventApi } from '../../services/api';
import Modal, { useConfirm } from '../../components/ui/Modal';
import Button, { IconButton } from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Pagination from '../../components/ui/Pagination';
import { SearchInput } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Choice';
import { Banner, EmptyText, SkeletonRows } from '../../components/ui/States';
import ParticipantsAdder, { ImportResult } from '../../components/participants/ParticipantsAdder';
import UserFaceModal from '../admin/UserFaceModal';
import { cx } from '../../utils/cx';

const PAGE_SIZE = 20;

// Danh sách tham gia của một sự kiện. Người tham gia không có tài khoản (spec
// 2026-11-07-participant-lists-design.md): BTC nhập email + họ tên, thêm cả lớp, và
// đặt ảnh khuôn mặt cho từng người để dùng kiosk check-in khuôn mặt.
export default function EventMembersModal({ open, eventId, onClose, onChanged }) {
  const confirm = useConfirm();
  // 'list' = danh sách hiện có · 'add' = nhập người · 'class' = thêm cả lớp
  const [mode, setMode] = useState('list');

  const [members, setMembers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastResult, setLastResult] = useState(null);
  const [faceUser, setFaceUser] = useState(null);

  // Thêm cả lớp
  const [classes, setClasses] = useState([]);
  const [classFilter, setClassFilter] = useState('');
  const [selectedClasses, setSelectedClasses] = useState({}); // classId -> remaining
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [savingClasses, setSavingClasses] = useState(false);

  const load = useCallback((p = 1, s = search) => {
    if (!eventId) return;
    setLoading(true);
    eventApi.listMembers(eventId, { page: p, limit: PAGE_SIZE, search: s })
      .then(({ data }) => { setMembers(data.data || []); setTotal(data.total || 0); })
      .catch(() => toast.error('Tải danh sách tham gia thất bại'))
      .finally(() => setLoading(false));
  }, [eventId, search]);

  useEffect(() => {
    if (open) {
      setPage(1);
      setSearch('');
      setMode('list');
      setLastResult(null);
      setSelectedClasses({});
      setClassFilter('');
      load(1, '');
    }
  }, [open]); // eslint-disable-line

  const goToPage = (p) => { setPage(p); load(p, search); };

  const handleSearchMembers = (v) => {
    setSearch(v);
    setPage(1);
    load(1, v);
  };

  const afterAdd = (result) => {
    setLastResult(result);
    setMode('list');
    setPage(1);
    load(1, search);
    onChanged?.();
  };

  // ── Thêm cả lớp ──────────────────────────────────────────────

  const openClassPanel = () => {
    setMode('class');
    setLoadingClasses(true);
    eventApi.listClasses(eventId)
      .then(({ data }) => setClasses(data.data || []))
      .catch(() => toast.error('Tải danh sách lớp thất bại'))
      .finally(() => setLoadingClasses(false));
  };

  const toggleClass = (c) => {
    setSelectedClasses((prev) => {
      const next = { ...prev };
      if (next[c.id] !== undefined) delete next[c.id];
      else next[c.id] = c.remaining;
      return next;
    });
  };

  const handleAddClasses = async () => {
    const ids = Object.keys(selectedClasses);
    if (ids.length === 0) return toast.error('Chưa chọn lớp nào');
    setSavingClasses(true);
    try {
      const { data } = await eventApi.addMembersByClass(eventId, ids);
      toast.success(data.message || 'Đã thêm lớp vào danh sách');
      setSelectedClasses({});
      afterAdd(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thêm lớp thất bại');
    } finally {
      setSavingClasses(false);
    }
    return undefined;
  };

  const handleRemove = async (m) => {
    if (!(await confirm({
      title: 'Xoá khỏi danh sách tham gia?',
      body: <><span className="font-medium text-foreground">{m.user.name}</span> sẽ bị xoá khỏi danh sách tham gia sự kiện.</>,
      confirmLabel: 'Xoá khỏi danh sách',
      icon: UserMinus,
    }))) return;
    try {
      await eventApi.removeMember(eventId, m.user.id);
      toast.success('Đã xoá khỏi danh sách');
      const nextPage = members.length === 1 && page > 1 ? page - 1 : page;
      setPage(nextPage);
      load(nextPage, search);
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Xoá thất bại');
    }
  };

  // Ảnh khuôn mặt — theo sự kiện, chỉ người trong danh sách này.
  const faceApiForEvent = {
    get: (userId) => eventApi.getMemberFace(eventId, userId),
    set: (userId, data) => eventApi.setMemberFace(eventId, userId, data),
    remove: (userId) => eventApi.deleteMemberFace(eventId, userId),
  };
  const onFaceChanged = (userId, status) => {
    setMembers((list) => list.map((m) => (m.user.id === userId ? { ...m, user: { ...m.user, faceStatus: status } } : m)));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const visibleClasses = classFilter.trim()
    ? classes.filter((c) => c.class.toLowerCase().includes(classFilter.trim().toLowerCase()))
    : classes;
  const selectedClassCount = Object.keys(selectedClasses).length;
  // Ước tính số suất sẽ thêm — chỉ đếm người của lớp chưa có trong danh sách.
  const willAddCount = Object.values(selectedClasses).reduce((a, b) => a + b, 0);

  const backToList = () => { setMode('list'); setSelectedClasses({}); setClassFilter(''); };

  const footer = mode === 'class' ? (
    <>
      <Button variant="secondary" size="form" onClick={backToList}>Huỷ</Button>
      <Button variant="primary" size="form" loading={savingClasses} disabled={selectedClassCount === 0} onClick={handleAddClasses}>
        {selectedClassCount === 0 ? 'Thêm cả lớp' : `Thêm ${willAddCount} người từ ${selectedClassCount} lớp`}
      </Button>
    </>
  ) : null;

  return (
    <>
      <Modal open={open && !faceUser} onClose={onClose} title="Danh sách tham gia sự kiện" size="lg" footer={footer}>
        {mode === 'list' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <SearchInput
                className="flex-1"
                placeholder="Tìm theo tên, MSSV, email…"
                value={search}
                onChange={(e) => handleSearchMembers(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button icon={GraduationCap} onClick={openClassPanel}>Thêm cả lớp</Button>
                <Button variant="primary" icon={UserPlus} onClick={() => setMode('add')}>Thêm người</Button>
              </div>
            </div>

            <ImportResult result={lastResult} onClose={() => setLastResult(null)} />

            {loading ? (
              <SkeletonRows rows={5} />
            ) : members.length === 0 ? (
              <EmptyText className="py-10">
                {search.trim() ? 'Không có ai khớp từ khoá' : 'Chưa có ai trong danh sách. Bấm "Thêm người" để dán danh sách email hoặc nhập file Excel.'}
              </EmptyText>
            ) : (
              <ul className="divide-y divide-border">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{m.user.name}</span>
                        {m.user.faceStatus === 'active' && <Badge tone="success" className="shrink-0">Có khuôn mặt</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {[m.user.mssv, m.user.email].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <IconButton
                      icon={ScanFace}
                      label={`Ảnh khuôn mặt của ${m.user.name}`}
                      onClick={() => setFaceUser({ ...m.user, role: 'STUDENT' })}
                    />
                    <IconButton icon={Trash2} label="Xoá khỏi danh sách" danger onClick={() => handleRemove(m)} />
                  </li>
                ))}
              </ul>
            )}

            {total > 0 && (
              <Pagination bare compact page={page} pages={totalPages} total={total} pageSize={PAGE_SIZE} noun="người" onPageChange={goToPage} />
            )}
          </div>
        )}

        {mode === 'add' && (
          <div className="flex flex-col gap-4">
            <PanelHeader title="Thêm người tham gia" onClose={backToList} />
            <ParticipantsAdder
              onAdd={(rows) => eventApi.addMembers(eventId, rows)}
              onImport={(file) => eventApi.importMembers(eventId, file)}
              onDone={afterAdd}
            />
          </div>
        )}

        {mode === 'class' && (
          <div className="flex flex-col gap-4">
            <PanelHeader title="Thêm cả lớp vào sự kiện" onClose={backToList} />
            <Banner tone="info" compact>
              Thêm toàn bộ danh sách của lớp (quản lý ở trang Lớp học). Người đã có trong danh sách được bỏ qua.
            </Banner>
            <SearchInput
              autoFocus
              placeholder="Lọc theo tên lớp…"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
            />
            <div className="max-h-72 overflow-y-auto">
              {loadingClasses ? (
                <SkeletonRows rows={3} avatar={false} />
              ) : visibleClasses.length === 0 ? (
                <EmptyText>
                  {classes.length === 0 ? 'Chưa có lớp nào có danh sách' : 'Không có lớp nào khớp từ khoá'}
                </EmptyText>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {visibleClasses.map((c) => {
                    const isSel = selectedClasses[c.id] !== undefined;
                    const isFull = c.remaining === 0;
                    return (
                      <li key={c.id}>
                        <label
                          className={cx(
                            'flex items-center gap-3 rounded-xl px-3 py-2.5',
                            isFull ? 'cursor-not-allowed opacity-50' : isSel ? 'cursor-pointer bg-secondary' : 'cursor-pointer hover:bg-item-hover',
                          )}
                        >
                          <Checkbox small checked={isSel} disabled={isFull} onChange={() => !isFull && toggleClass(c)} ariaLabel={`Chọn lớp ${c.class}`} />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{c.class}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted">
                            {isFull
                              ? <span className="font-medium text-success">đã có đủ {c.total}</span>
                              : <><span className="font-medium text-foreground">{c.remaining}</span> / {c.total} chưa có</>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>

      <UserFaceModal user={faceUser} api={faceApiForEvent} onClose={() => setFaceUser(null)} onChanged={onFaceChanged} />
    </>
  );
}

/* ─────────────────────────────────────── */

function PanelHeader({ title, onClose }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <Button variant="ghost" size="sm" icon={X} onClick={onClose}>Đóng</Button>
    </div>
  );
}
