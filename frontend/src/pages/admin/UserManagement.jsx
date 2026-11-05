import { useState, useEffect, useCallback, useRef } from 'react';
import { Copy, Ellipsis, KeyRound, Lock, Pencil, Plus, ScanFace, Smartphone, Trash2, Upload, UserCheck, UserX } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import Layout from '../../components/layout/Layout';
import Button, { IconButton } from '../../components/ui/Button';
import Badge, { RoleBadge } from '../../components/ui/Badge';
import Avatar from '../../components/ui/Avatar';
import Modal, { useConfirm } from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import Tabs from '../../components/ui/Tabs';
import Pagination from '../../components/ui/Pagination';
import Dropdown, { MenuGroup, MenuItem, MenuSeparator } from '../../components/ui/Dropdown';
import { TableCard, Th } from '../../components/ui/Card';
import { Field, Input, SearchInput } from '../../components/ui/Input';
import { CheckCell } from '../../components/ui/Choice';
import { LoadError, SkeletonRows } from '../../components/ui/States';
import { cx } from '../../utils/cx';
import ImportStudents from './ImportStudents';
import FaceImport from './FaceImport';
import UserFaceModal, { FACE_STATUS } from './UserFaceModal';
import BulkUserActions, { MAX_BULK } from './BulkUserActions';

const PAGE_SIZES = [20, 50, 100];
const EMPTY_FORM = { name: '', email: '', mssv: '', role: 'STUDENT', class: '', faculty: '', phone: '' };

const ROLE_OPTIONS = [
  { value: 'STUDENT', label: 'Sinh viên' },
  { value: 'BTC', label: 'Ban tổ chức' },
  { value: 'LECTURER', label: 'Giảng viên' },
  { value: 'ADMIN', label: 'Admin' },
];
const ROLE_FILTERS = [{ value: '', label: 'Tất cả' }, ...ROLE_OPTIONS];
const STATUS_TABS = [
  { value: '', label: 'Tất cả' },
  { value: 'active', label: 'Hoạt động' },
  { value: 'locked', label: 'Bị khoá' },
];

// Các trường của tài khoản: một form cho cả tạo và sửa
function UserFormFields({ state, setState }) {
  const set = (key) => (e) => setState({ ...state, [key]: e.target.value });
  return (
    <div className="flex flex-col gap-5">
      <Field label="Họ và tên" required>
        {(id) => <Input id={id} placeholder="Nguyễn Văn An" value={state.name} onChange={set('name')} />}
      </Field>
      <Field label="Email" required>
        {(id) => <Input id={id} type="email" placeholder="sv@fpt.edu.vn" value={state.email} onChange={set('email')} />}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Vai trò">
          {(id) => <Select id={id} value={state.role} options={ROLE_OPTIONS} onChange={(role) => setState({ ...state, role })} />}
        </Field>
        <Field label="MSSV" hint="Không bắt buộc với BTC, giảng viên">
          {(id) => <Input id={id} placeholder="SE123456" value={state.mssv} onChange={set('mssv')} />}
        </Field>
        <Field label="Lớp" optional>
          {(id) => <Input id={id} placeholder="SE1701" value={state.class} onChange={set('class')} />}
        </Field>
        <Field label="Khoa" optional>
          {(id) => <Input id={id} placeholder="Software Engineering" value={state.faculty} onChange={set('faculty')} />}
        </Field>
      </div>
      <Field label="Số điện thoại" optional>
        {(id) => <Input id={id} type="tel" placeholder="09xxxxxxxx" value={state.phone} onChange={set('phone')} />}
      </Field>
    </div>
  );
}

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const confirm = useConfirm();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  // Lựa chọn giữ theo id → user (không chỉ id) để thanh thao tác hiển thị được
  // tên, và để lựa chọn SỐNG QUA phân trang: admin có thể gom người từ nhiều trang.
  const [selected, setSelected] = useState(new Map());
  const lastClickedIndex = useRef(null);
  const [selectingAll, setSelectingAll] = useState(false);

  const [createModal, setCreateModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [faceImportModal, setFaceImportModal] = useState(false);
  const [faceUser, setFaceUser] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  // Edit
  const [editModal, setEditModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Đặt lại mật khẩu (admin)
  const [pwdModal, setPwdModal] = useState(false);
  const [pwdUser, setPwdUser] = useState(null);
  const [pwdMode, setPwdMode] = useState('auto');
  const [pwdValue, setPwdValue] = useState('');
  const [pwdResult, setPwdResult] = useState(null);
  const [resetting, setResetting] = useState(false);

  const filtersRef = useRef({ search: '', role: '', status: '', pageSize: PAGE_SIZES[0] });
  filtersRef.current = { search, role: roleFilter, status: statusFilter, pageSize };

  const load = useCallback((p = 1, override = {}) => {
    const f = { ...filtersRef.current, ...override };
    setLoadError(false);
    setLoading(true);
    lastClickedIndex.current = null;
    return adminApi.listUsers({ search: f.search, role: f.role, status: f.status, page: p, limit: f.pageSize })
      .then(({ data }) => { setUsers(data.data || []); setTotal(data.total || 0); })
      .catch(() => { setLoadError(true); toast.error('Tải danh sách thất bại'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(1); }, []); // eslint-disable-line

  // Gõ tìm kiếm bắn 1 request/ký tự là quá tốn với Render free tier → chờ 350ms.
  const searchTimer = useRef(null);
  const onSearchChange = (value) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setPage(1); load(1, { search: value }); }, 350);
  };
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const applyFilter = (patch) => {
    if ('role' in patch) setRoleFilter(patch.role);
    if ('status' in patch) setStatusFilter(patch.status);
    if ('pageSize' in patch) setPageSize(patch.pageSize);
    setPage(1);
    load(1, patch);
  };

  const goToPage = (p) => {
    setPage(p);
    load(p);
  };

  // ── Lựa chọn ──────────────────────────────────────────────────

  const isSelected = (id) => selected.has(id);
  const pageAllSelected = users.length > 0 && users.every((u) => selected.has(u.id));
  const pageSomeSelected = users.some((u) => selected.has(u.id));

  const setMany = (list, on) => {
    setSelected((prev) => {
      const next = new Map(prev);
      list.forEach((u) => (on ? next.set(u.id, u) : next.delete(u.id)));
      return next;
    });
  };

  // Shift-click chọn cả dải giữa hai lần click — thao tác quen tay khi cần
  // chọn vài chục dòng liên tiếp.
  const toggleRow = (index, event) => {
    const target = users[index];
    const on = !selected.has(target.id);

    if (event.shiftKey && lastClickedIndex.current !== null) {
      const [from, to] = [lastClickedIndex.current, index].sort((a, b) => a - b);
      setMany(users.slice(from, to + 1), on);
    } else {
      setMany([target], on);
    }
    lastClickedIndex.current = index;
  };

  const togglePage = () => {
    setMany(users, !pageAllSelected);
    lastClickedIndex.current = null;
  };

  const clearSelection = () => { setSelected(new Map()); lastClickedIndex.current = null; };

  // Chọn toàn bộ kết quả khớp bộ lọc, không chỉ trang hiện tại. Backend chặn
  // limit ở MAX_BULK nên đây cũng là trần của một lô thao tác.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const { data } = await adminApi.listUsers({
        search, role: roleFilter, status: statusFilter, page: 1, limit: MAX_BULK,
      });
      const list = data.data || [];
      setSelected(new Map(list.map((u) => [u.id, u])));
      toast.success(
        list.length < total
          ? `Đã chọn ${list.length} tài khoản đầu tiên (tối đa ${MAX_BULK} mỗi lô)`
          : `Đã chọn tất cả ${list.length} tài khoản`
      );
    } catch {
      toast.error('Không chọn được toàn bộ kết quả');
    } finally {
      setSelectingAll(false);
    }
  };

  // ── Thao tác từng người ───────────────────────────────────────

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email) return toast.error('Nhập đầy đủ tên và email');
    setCreating(true);
    try {
      await adminApi.createUser(form);
      toast.success('Tạo tài khoản thành công. Email đã gửi.');
      setCreateModal(false);
      setForm(EMPTY_FORM);
      setPage(1);
      load(1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Tạo thất bại');
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (u) => {
    setEditUser(u);
    setEditForm({
      name: u.name || '',
      email: u.email || '',
      mssv: u.mssv || '',
      role: u.role || 'STUDENT',
      class: u.class || '',
      faculty: u.faculty || '',
      phone: u.phone || '',
    });
    setEditModal(true);
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.name || !editForm.email) return toast.error('Nhập đầy đủ tên và email');
    setSaving(true);
    try {
      await adminApi.updateUser(editUser.id, editForm);
      toast.success('Cập nhật thành công');
      setEditModal(false);
      setEditUser(null);
      load(page);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cập nhật thất bại');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u) => {
    if (!(await confirm({
      title: 'Xoá vĩnh viễn tài khoản?',
      body: <>Tài khoản <span className="font-medium text-foreground">{u.name}</span> sẽ bị xoá. Hành động này không thể hoàn tác.</>,
      confirmLabel: 'Xoá tài khoản',
    }))) return;
    try {
      await adminApi.deleteUser(u.id);
      toast.success('Đã xoá người dùng');
      setMany([u], false);
      // Nếu xoá bản ghi cuối của trang, lùi 1 trang
      const nextPage = users.length === 1 && page > 1 ? page - 1 : page;
      setPage(nextPage);
      load(nextPage);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Xoá thất bại');
    }
  };

  const openResetPassword = (u) => {
    setPwdUser(u);
    setPwdMode('auto');
    setPwdValue('');
    setPwdResult(null);
    setPwdModal(true);
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (pwdMode === 'manual' && pwdValue.length < 6) {
      return toast.error('Mật khẩu mới phải ít nhất 6 ký tự');
    }
    setResetting(true);
    try {
      const { data } = await adminApi.resetPassword(
        pwdUser.id,
        pwdMode === 'manual' ? { newPassword: pwdValue } : {}
      );
      setPwdResult(data);
      toast[data.emailSent ? 'success' : 'error'](data.message);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Đặt lại mật khẩu thất bại');
    } finally {
      setResetting(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(pwdResult.password);
      toast.success('Đã sao chép mật khẩu');
    } catch {
      toast.error('Trình duyệt không cho phép sao chép. Hãy chọn và copy thủ công.');
    }
  };

  const handleResetDevice = async (id, name) => {
    if (!(await confirm({
      title: 'Reset thiết bị?',
      body: <>Thiết bị tin cậy của <span className="font-medium text-foreground">{name}</span> bị gỡ, lần đăng nhập kế tiếp sẽ cần mã OTP.</>,
      confirmLabel: 'Reset thiết bị',
      tone: 'neutral',
      icon: Smartphone,
    }))) return;
    try {
      await adminApi.resetDevice(id);
      toast.success('Đã reset thiết bị');
    } catch {
      toast.error('Reset thất bại');
    }
  };

  const handleToggleActive = async (id, isActive, name) => {
    if (!(await confirm({
      title: isActive ? 'Khoá tài khoản?' : 'Mở khoá tài khoản?',
      body: isActive
        ? <><span className="font-medium text-foreground">{name}</span> sẽ không đăng nhập được, dữ liệu điểm danh vẫn giữ nguyên.</>
        : <><span className="font-medium text-foreground">{name}</span> có thể đăng nhập lại bằng mật khẩu hiện tại.</>,
      confirmLabel: isActive ? 'Khoá tài khoản' : 'Mở khoá',
      tone: isActive ? 'danger' : 'neutral',
      icon: isActive ? UserX : UserCheck,
    }))) return;
    try {
      await adminApi.updateUser(id, { isActive: !isActive });
      toast.success(`Đã ${isActive ? 'khoá' : 'mở khoá'} tài khoản`);
      load(page);
    } catch {
      toast.error('Thao tác thất bại');
    }
  };

  // Modal ảnh khuôn mặt báo lại trạng thái mới → sửa dòng tại chỗ, khỏi tải lại cả trang.
  const onFaceChanged = (id, faceStatus) => {
    setUsers((list) => list.map((u) => (u.id === id ? { ...u, faceStatus } : u)));
  };

  const totalPages = Math.ceil(total / pageSize);
  const hasFilters = Boolean(search || roleFilter || statusFilter);

  const rowMenu = (u) => {
    const me = u.id === currentUser?.id;
    return (
      <Dropdown align="end" ariaLabel="Thao tác" trigger={<IconButton icon={Ellipsis} label="Thao tác" row />}>
        <MenuGroup>
          <MenuItem icon={Pencil} onSelect={() => openEdit(u)}>Sửa thông tin</MenuItem>
          {(u.role === 'STUDENT' || (u.faceStatus && u.faceStatus !== 'none')) && (
            <MenuItem icon={ScanFace} onSelect={() => setFaceUser(u)}>Ảnh khuôn mặt</MenuItem>
          )}
          {!me && (
            <>
              <MenuItem icon={KeyRound} onSelect={() => openResetPassword(u)}>Đặt lại mật khẩu</MenuItem>
              <MenuItem icon={Smartphone} onSelect={() => handleResetDevice(u.id, u.name)}>Reset thiết bị</MenuItem>
              <MenuItem icon={u.isActive ? UserX : UserCheck} onSelect={() => handleToggleActive(u.id, u.isActive, u.name)}>
                {u.isActive ? 'Khoá tài khoản' : 'Mở khoá'}
              </MenuItem>
            </>
          )}
        </MenuGroup>
        {!me && (
          <>
            <MenuSeparator />
            <MenuGroup><MenuItem icon={Trash2} danger onSelect={() => handleDelete(u)}>Xoá vĩnh viễn</MenuItem></MenuGroup>
          </>
        )}
      </Dropdown>
    );
  };

  let table;
  if (loading) table = <SkeletonRows rows={8} />;
  else if (loadError) table = <LoadError title="Không tải được danh sách người dùng" onRetry={() => load(page)} />;
  else if (users.length === 0) {
    table = search ? (
      <p className="text-pretty py-10 text-center text-sm text-muted">
        Không có tài khoản nào khớp <span className="text-foreground">“{search}”</span>. Thử từ khoá khác.{' '}
        <button type="button" onClick={() => onSearchChange('')} className="font-medium text-foreground underline-offset-4 hover:underline">Xoá tìm kiếm</button>
      </p>
    ) : (
      <p className="py-10 text-center text-sm text-muted">Không có tài khoản nào{hasFilters ? ' khớp bộ lọc' : ''}.</p>
    );
  } else {
    table = (
      <>
        {/* Chọn cả trang rồi thì mời chọn luôn toàn bộ kết quả khớp bộ lọc */}
        {pageAllSelected && total > users.length && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-border bg-background px-4 py-2.5 text-sm text-foreground">
            <span>Đã chọn {selected.size} tài khoản.</span>
            {selected.size < total && (
              <button type="button" onClick={selectAllMatching} disabled={selectingAll}
                className="font-medium underline underline-offset-4 outline-none disabled:opacity-50">
                {selectingAll ? 'Đang chọn…' : `Chọn tất cả ${total.toLocaleString('vi-VN')} kết quả${hasFilters ? ' khớp bộ lọc' : ''}`}
              </button>
            )}
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <CheckCell as="th" checked={pageAllSelected} indeterminate={!pageAllSelected && pageSomeSelected} onChange={togglePage} ariaLabel="Chọn tất cả trên trang này" />
              <Th className="w-full">Người dùng</Th>
              <Th className="hidden md:table-cell">MSSV</Th>
              <Th className="hidden lg:table-cell">Lớp</Th>
              <Th className="hidden sm:table-cell">Vai trò</Th>
              <Th className="hidden xl:table-cell">Khuôn mặt</Th>
              <th className="w-px px-2"><span className="sr-only">Thao tác</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, index) => {
              const checked = isSelected(u.id);
              const me = u.id === currentUser?.id;
              return (
                <tr key={u.id} className={cx('border-b border-border last:border-0 hover:bg-surface-hover', checked && 'bg-surface-hover')}>
                  {me ? (
                    <td className="w-px p-0" />
                  ) : (
                    <CheckCell
                      checked={checked}
                      onChange={() => {}}
                      onClick={(e) => toggleRow(index, e)}
                      title="Giữ Shift để chọn cả dải"
                      ariaLabel={`Chọn ${u.name}`}
                    />
                  )}
                  <td className="max-w-0 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={u.name} seed={u.email} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate font-medium text-foreground" title={u.name}>{u.name}</p>
                          {me && <span className="shrink-0 text-xs text-muted">Bạn</span>}
                          {!u.isActive && <Badge tone="error" icon={Lock} className="shrink-0">Bị khoá</Badge>}
                        </div>
                        <p className="truncate text-xs text-muted">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className={cx('hidden whitespace-nowrap px-4 py-3 tabular-nums md:table-cell', u.mssv ? 'text-foreground' : 'text-muted')}>{u.mssv || '—'}</td>
                  <td className={cx('hidden whitespace-nowrap px-4 py-3 lg:table-cell', u.class ? 'text-foreground' : 'text-muted')}>{u.class || '—'}</td>
                  <td className="hidden px-4 py-3 sm:table-cell"><RoleBadge role={u.role} /></td>
                  <td className="hidden whitespace-nowrap px-4 py-3 xl:table-cell">
                    {u.role === 'STUDENT' || (u.faceStatus && u.faceStatus !== 'none') ? (
                      <button type="button" onClick={() => setFaceUser(u)} title="Xem / sửa ảnh khuôn mặt" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <Badge tone={FACE_STATUS[u.faceStatus || 'none'].tone} icon={ScanFace}>{FACE_STATUS[u.faceStatus || 'none'].label}</Badge>
                      </button>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-3">{rowMenu(u)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pagination
          page={page}
          pages={totalPages}
          total={total}
          pageSize={pageSize}
          noun="tài khoản"
          onPageChange={goToPage}
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(n) => applyFilter({ pageSize: n })}
        />
      </>
    );
  }

  return (
    <Layout
      title="Người dùng"
      headerRight={(
        <>
          <Button size="hdr" icon={Upload} aria-label="Import Excel" onClick={() => setImportModal(true)}>
            <span className="hidden sm:inline">Import Excel</span>
          </Button>
          <Button size="hdr" icon={ScanFace} aria-label="Import ảnh khuôn mặt" onClick={() => setFaceImportModal(true)}>
            <span className="hidden sm:inline">Ảnh khuôn mặt</span>
          </Button>
          <Button variant="primary" size="hdr" icon={Plus} onClick={() => { setForm(EMPTY_FORM); setCreateModal(true); }}>Tạo tài khoản</Button>
        </>
      )}
    >
      <div className="mb-4">
        {selected.size === 0 && (
          <div className="flex min-h-10 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Tabs variant="boxed" ariaLabel="Lọc theo trạng thái" items={STATUS_TABS} value={statusFilter} onChange={(status) => applyFilter({ status })} />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <SearchInput className="w-full sm:w-64" placeholder="Tìm theo tên, MSSV, email" value={search} onChange={(e) => onSearchChange(e.target.value)} />
              <Select inline label="Vai trò:" aria-label="Lọc theo vai trò" value={roleFilter} options={ROLE_FILTERS} onChange={(role) => applyFilter({ role })} />
            </div>
          </div>
        )}
        <BulkUserActions
          selected={[...selected.values()]}
          currentUserId={currentUser?.id}
          onClear={clearSelection}
          onDone={() => load(page)}
        />
      </div>

      <TableCard>{table}</TableCard>

      {/* Tạo tài khoản */}
      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="Tạo tài khoản mới"
        description="Mật khẩu tạm thời sẽ được gửi qua email."
        size="md"
        footer={(
          <>
            <Button variant="secondary" size="form" onClick={() => setCreateModal(false)}>Huỷ</Button>
            <Button type="submit" form="create-user-form" variant="primary" size="form" loading={creating}>Tạo tài khoản</Button>
          </>
        )}
      >
        <form id="create-user-form" onSubmit={handleCreate}>
          <UserFormFields state={form} setState={setForm} />
        </form>
      </Modal>

      {/* Sửa thông tin */}
      <Modal
        open={editModal}
        onClose={() => setEditModal(false)}
        title="Sửa thông tin người dùng"
        size="md"
        footer={(
          <>
            <Button variant="secondary" size="form" onClick={() => setEditModal(false)}>Huỷ</Button>
            <Button type="submit" form="edit-user-form" variant="primary" size="form" loading={saving}>Lưu thay đổi</Button>
          </>
        )}
      >
        <form id="edit-user-form" onSubmit={handleSaveEdit}>
          <UserFormFields state={editForm} setState={setEditForm} />
        </form>
      </Modal>

      {/* Đặt lại mật khẩu */}
      <Modal
        open={pwdModal}
        onClose={() => setPwdModal(false)}
        title="Đặt lại mật khẩu"
        size="sm"
        footer={pwdResult ? (
          <Button variant="primary" size="form" onClick={() => setPwdModal(false)}>Đóng</Button>
        ) : (
          <>
            <Button variant="secondary" size="form" onClick={() => setPwdModal(false)}>Huỷ</Button>
            <Button type="submit" form="reset-password-form" variant="primary" size="form" loading={resetting}>Đặt lại mật khẩu</Button>
          </>
        )}
      >
        {pwdResult ? (
          <div className="flex flex-col gap-4">
            <p className="text-pretty text-sm text-muted">
              Đã đặt lại mật khẩu của <span className="font-medium text-foreground">{pwdUser?.name}</span>.
            </p>
            <div className="rounded-xl bg-background p-4">
              <p className="mb-1 text-xs text-muted">Mật khẩu mới</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 select-all break-all font-mono text-base text-foreground">{pwdResult.password}</code>
                <IconButton icon={Copy} label="Sao chép" onClick={copyPassword} />
              </div>
            </div>
            <p className={cx('text-pretty text-sm', pwdResult.emailSent ? 'text-muted' : 'font-medium text-error-text')}>
              {pwdResult.emailSent
                ? `Email kèm mật khẩu mới đã được gửi đến ${pwdUser?.email}.`
                : 'Không gửi được email — hãy sao chép mật khẩu và bàn giao trực tiếp.'}
            </p>
          </div>
        ) : (
          <form id="reset-password-form" onSubmit={handleResetPassword} className="flex flex-col gap-4">
            <div className="rounded-xl bg-background p-3">
              <p className="text-sm font-medium text-foreground">{pwdUser?.name}</p>
              <p className="text-xs text-muted">{pwdUser?.email}</p>
            </div>
            <div role="radiogroup" aria-label="Cách đặt mật khẩu" className="flex flex-col gap-2">
              {[
                { value: 'auto', label: 'Sinh mật khẩu tạm ngẫu nhiên', hint: 'Hệ thống tự tạo và gửi email cho người dùng' },
                { value: 'manual', label: 'Tự nhập mật khẩu', hint: 'Tối thiểu 6 ký tự' },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={cx(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                    pwdMode === opt.value ? 'border-primary bg-primary-light' : 'border-border-strong hover:bg-item-hover',
                  )}
                >
                  <input
                    type="radio"
                    name="pwdMode"
                    value={opt.value}
                    checked={pwdMode === opt.value}
                    onChange={() => setPwdMode(opt.value)}
                    className="peer mt-0.5 size-5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-border-strong bg-surface outline-none checked:border-[6px] checked:border-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                    <span className="mt-0.5 block text-sm text-muted">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {pwdMode === 'manual' && (
              <Field label="Mật khẩu mới" required>
                {(id) => <Input id={id} type="text" autoComplete="new-password" placeholder="Ít nhất 6 ký tự" value={pwdValue} onChange={(e) => setPwdValue(e.target.value)} />}
              </Field>
            )}
            <p className="text-pretty text-sm text-muted">
              Mật khẩu mới được gửi qua email, phải đổi ở lần đăng nhập kế tiếp. Tài khoản đang bị khoá cũng được mở.
            </p>
          </form>
        )}
      </Modal>

      {/* Import */}
      <Modal open={importModal} onClose={() => setImportModal(false)} title="Import sinh viên từ Excel" size="sm">
        <ImportStudents onSuccess={() => { setImportModal(false); setPage(1); load(1); }} />
      </Modal>

      {/* Import ảnh thẻ để check-in bằng khuôn mặt */}
      <Modal open={faceImportModal} onClose={() => setFaceImportModal(false)} title="Import ảnh khuôn mặt theo MSSV" size="md">
        <FaceImport onDone={() => load(page)} />
      </Modal>

      {/* Ảnh khuôn mặt của một người: xem, thay, xoá */}
      <UserFaceModal user={faceUser} onClose={() => setFaceUser(null)} onChanged={onFaceChanged} />
    </Layout>
  );
}
