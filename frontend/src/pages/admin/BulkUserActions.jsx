import { useState } from 'react';
import { Copy, Ellipsis, KeyRound, Pencil, Smartphone, Trash2, UserCheck, UserX } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminApi } from '../../services/api';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import Select from '../../components/ui/Select';
import Tabs from '../../components/ui/Tabs';
import Dropdown, { MenuGroup, MenuItem } from '../../components/ui/Dropdown';
import { Field, Input } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Choice';
import { Banner } from '../../components/ui/States';

// Trần của backend (lib/bulkUsers.js). Chặn sớm ở đây để admin thấy lý do
// ngay trên thanh thao tác thay vì bấm xong mới nhận lỗi 400.
const MAX_BULK = 200;
const MAX_BULK_PASSWORD = 50;

// Chỉ vai trò nhân sự — người tham gia không có tài khoản nên không đổi ai thành STUDENT được.
const ROLE_OPTIONS = [
  { value: 'BTC', label: 'Ban tổ chức' },
  { value: 'ADMIN', label: 'Admin' },
];

const EMPTY_EDIT = {
  role: { on: false, value: 'STUDENT' },
  class: { on: false, value: '' },
  faculty: { on: false, value: '' },
  isActive: { on: false, value: true },
};

// Kết quả hàng loạt luôn "thành công một phần" được: hiện rõ số đã xử lý và
// TỪNG tài khoản bị bỏ qua kèm lý do, đừng nuốt vào một dòng toast.
function BulkResult({ result, children }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-success-bg p-4 text-sm font-medium text-success">{result.message}</p>
      {children}
      {result.skipped?.length > 0 && (
        <div className="rounded-xl bg-warning-bg p-4">
          <p className="mb-2 text-sm font-medium text-warning">{result.skipped.length} tài khoản bị bỏ qua</p>
          <ul className="flex flex-col gap-1.5">
            {result.skipped.map((s) => (
              <li key={s.id} className="text-pretty text-sm text-foreground/80">
                <span className="font-medium text-foreground">{s.name}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Thanh thao tác hàng loạt (thay chỗ hàng lọc khi có dòng được chọn) và các hộp xử lý.
// Không chọn ai thì chỉ còn các hộp (để chạy hết chuyển động đóng).
export default function BulkUserActions({ selected, currentUserId, onClear, onDone }) {
  const [modal, setModal] = useState(null); // 'edit' | 'password' | 'device' | 'delete' | 'lock' | 'unlock'
  const [edit, setEdit] = useState(EMPTY_EDIT);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const ids = selected.map((u) => u.id);
  const count = selected.length;
  const includesSelf = ids.includes(currentUserId);
  // Tài khoản của chính admin luôn bị backend loại khỏi lô → đếm theo số thực sự bị tác động.
  const affected = includesSelf ? count - 1 : count;

  const close = () => { setModal(null); setResult(null); setConfirmText(''); };

  // Đóng modal có kết quả = danh sách đã đổi → nạp lại bảng và xoá lựa chọn.
  const finish = () => {
    close();
    onClear();
    onDone();
  };

  const run = async (fn) => {
    setBusy(true);
    try {
      const { data } = await fn();
      setResult(data);
      if (data.skipped?.length === 0) toast.success(data.message);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thao tác thất bại');
    } finally {
      setBusy(false);
    }
  };

  const openEdit = () => { setEdit(EMPTY_EDIT); setResult(null); setModal('edit'); };

  const submitEdit = (e) => {
    e.preventDefault();
    const patch = {};
    if (edit.role.on) patch.role = edit.role.value;
    if (edit.class.on) patch.class = edit.class.value;
    if (edit.faculty.on) patch.faculty = edit.faculty.value;
    if (edit.isActive.on) patch.isActive = edit.isActive.value;

    if (Object.keys(patch).length === 0) {
      return toast.error('Hãy bật ít nhất một trường để thay đổi');
    }
    run(() => adminApi.bulkUpdate(ids, patch));
  };

  const openToggleActive = (value) => {
    setEdit({ ...EMPTY_EDIT, isActive: { on: true, value } });
    setResult(null);
    setModal(value ? 'unlock' : 'lock');
  };

  const submitToggleActive = (value) => run(() => adminApi.bulkUpdate(ids, { isActive: value }));

  const copyAllPasswords = async () => {
    const text = result.results
      .map((r) => [r.name, r.email, r.password].join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Đã sao chép danh sách mật khẩu');
    } catch {
      toast.error('Trình duyệt không cho phép sao chép. Hãy bôi đen và copy thủ công.');
    }
  };

  const tooManyForPassword = affected > MAX_BULK_PASSWORD;

  const summary = (
    <div className="flex flex-col gap-1 rounded-xl bg-background p-3">
      <p className="text-sm font-medium text-foreground">{affected} tài khoản sẽ bị tác động</p>
      <p className="line-clamp-3 text-pretty text-sm text-muted">
        {selected.filter((u) => u.id !== currentUserId).map((u) => u.name).join(', ')}
      </p>
      {includesSelf && <p className="text-sm font-medium text-warning">Tài khoản của bạn nằm trong lựa chọn và sẽ được bỏ qua.</p>}
    </div>
  );

  const doneFooter = <Button variant="primary" size="form" onClick={finish}>Đóng</Button>;
  const formFooter = (action) => (
    <>
      <Button variant="secondary" size="form" onClick={close}>Huỷ</Button>
      {action}
    </>
  );

  return (
    <>
      {count > 0 && (
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          <p className="mr-2 text-sm font-medium text-foreground"><span className="tabular-nums">{count}</span> đã chọn</p>
          <Button variant="ghost" size="sm" onClick={onClear}>Bỏ chọn</Button>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button icon={Pencil} disabled={affected === 0} onClick={openEdit}>Sửa thông tin</Button>
            <Button
              icon={KeyRound}
              disabled={affected === 0 || tooManyForPassword}
              title={tooManyForPassword ? `Chỉ đặt lại được tối đa ${MAX_BULK_PASSWORD} tài khoản mỗi lần` : undefined}
              onClick={() => { setResult(null); setModal('password'); }}
            >
              Đặt lại mật khẩu
            </Button>
            <Dropdown align="end" ariaLabel="Thao tác khác" trigger={<Button icon={Ellipsis} disabled={affected === 0}>Khác</Button>}>
              <MenuGroup>
                <MenuItem icon={UserX} onSelect={() => openToggleActive(false)}>Khoá</MenuItem>
                <MenuItem icon={UserCheck} onSelect={() => openToggleActive(true)}>Mở khoá</MenuItem>
                <MenuItem icon={Smartphone} onSelect={() => { setResult(null); setModal('device'); }}>Reset thiết bị</MenuItem>
              </MenuGroup>
            </Dropdown>
            <Button variant="danger" icon={Trash2} disabled={affected === 0} onClick={() => { setResult(null); setConfirmText(''); setModal('delete'); }}>
              Xoá
            </Button>
          </div>
        </div>
      )}

      {/* Sửa hàng loạt */}
      <Modal
        open={modal === 'edit'}
        onClose={result ? finish : close}
        title={`Sửa ${affected} tài khoản`}
        description={result ? undefined : 'Chỉ những trường được bật mới bị ghi đè.'}
        size="sm"
        footer={result ? doneFooter : formFooter(<Button type="submit" form="bulk-edit-form" variant="primary" size="form" loading={busy}>Áp dụng</Button>)}
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <form id="bulk-edit-form" onSubmit={submitEdit} className="flex flex-col gap-4">
            {summary}
            <BulkField label="Vai trò" state={edit.role} onToggle={(on) => setEdit({ ...edit, role: { ...edit.role, on } })}>
              <Select aria-label="Vai trò" value={edit.role.value} options={ROLE_OPTIONS}
                onChange={(value) => setEdit({ ...edit, role: { on: true, value } })} />
            </BulkField>
            <BulkField label="Lớp" state={edit.class} onToggle={(on) => setEdit({ ...edit, class: { ...edit.class, on } })}>
              <Input aria-label="Lớp" placeholder="SE1701 — để trống để xoá lớp" value={edit.class.value}
                onChange={(e) => setEdit({ ...edit, class: { on: true, value: e.target.value } })} />
            </BulkField>
            <BulkField label="Khoa" state={edit.faculty} onToggle={(on) => setEdit({ ...edit, faculty: { ...edit.faculty, on } })}>
              <Input aria-label="Khoa" placeholder="Software Engineering — để trống để xoá khoa" value={edit.faculty.value}
                onChange={(e) => setEdit({ ...edit, faculty: { on: true, value: e.target.value } })} />
            </BulkField>
            <BulkField label="Trạng thái" state={edit.isActive} onToggle={(on) => setEdit({ ...edit, isActive: { ...edit.isActive, on } })}>
              <Tabs
                variant="segmented"
                layout="full"
                ariaLabel="Trạng thái"
                value={edit.isActive.value ? 'active' : 'locked'}
                onChange={(v) => setEdit({ ...edit, isActive: { on: true, value: v === 'active' } })}
                items={[{ value: 'active', label: 'Hoạt động', grow: true }, { value: 'locked', label: 'Bị khoá', grow: true }]}
              />
            </BulkField>
          </form>
        )}
      </Modal>

      {/* Khoá / Mở khoá hàng loạt */}
      <Modal
        open={modal === 'lock' || modal === 'unlock'}
        onClose={result ? finish : close}
        title={modal === 'lock' ? `Khoá ${affected} tài khoản` : `Mở khoá ${affected} tài khoản`}
        size="sm"
        footer={result ? doneFooter : formFooter(
          <Button
            variant={modal === 'lock' ? 'danger' : 'primary'}
            size="form"
            loading={busy}
            onClick={() => submitToggleActive(modal === 'unlock')}
          >
            {modal === 'lock' ? 'Khoá tất cả' : 'Mở khoá tất cả'}
          </Button>,
        )}
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="flex flex-col gap-4">
            {summary}
            <p className="text-pretty text-sm text-muted">
              {modal === 'lock'
                ? 'Tài khoản bị khoá không đăng nhập được, dữ liệu điểm danh vẫn giữ nguyên.'
                : 'Người dùng có thể đăng nhập lại bằng mật khẩu hiện tại.'}
            </p>
          </div>
        )}
      </Modal>

      {/* Reset mật khẩu hàng loạt */}
      <Modal
        open={modal === 'password'}
        onClose={result ? finish : close}
        title={`Đặt lại mật khẩu cho ${affected} tài khoản`}
        size="lg"
        footer={result ? doneFooter : formFooter(
          <Button variant="primary" size="form" loading={busy} onClick={() => run(() => adminApi.bulkResetPassword(ids))}>Đặt lại mật khẩu</Button>,
        )}
      >
        {result ? (
          <BulkResult result={result}>
            {result.results?.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-border-strong">
                <div className="flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-2.5">
                  <p className="text-pretty text-xs text-muted">Mật khẩu tạm — người dùng phải đổi ở lần đăng nhập kế tiếp</p>
                  <Button size="sm" icon={Copy} onClick={copyAllPasswords} className="shrink-0">Sao chép tất cả</Button>
                </div>
                <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                  {result.results.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{r.name}</p>
                        <p className="truncate text-xs text-muted">{r.email}</p>
                      </div>
                      <code className="select-all font-mono text-sm text-foreground">{r.password}</code>
                      <span className={`text-xs font-medium ${r.emailSent ? 'text-success' : 'text-error-text'}`}>
                        {r.emailSent ? 'Đã gửi email' : 'Email lỗi'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </BulkResult>
        ) : (
          <div className="flex flex-col gap-4">
            {summary}
            <p className="text-pretty text-sm text-muted">
              Mỗi người nhận một mật khẩu tạm qua email, phải đổi ở lần đăng nhập kế tiếp. Tài khoản đang bị khoá cũng được mở.
            </p>
          </div>
        )}
      </Modal>

      {/* Reset thiết bị hàng loạt */}
      <Modal
        open={modal === 'device'}
        onClose={result ? finish : close}
        title={`Reset thiết bị cho ${affected} tài khoản`}
        size="sm"
        footer={result ? doneFooter : formFooter(
          <Button variant="primary" size="form" loading={busy} onClick={() => run(() => adminApi.bulkResetDevice(ids))}>Reset thiết bị</Button>,
        )}
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="flex flex-col gap-4">
            {summary}
            <p className="text-pretty text-sm text-muted">Gỡ thiết bị đã tin cậy — lần đăng nhập kế tiếp sẽ cần mã OTP.</p>
          </div>
        )}
      </Modal>

      {/* Xoá hàng loạt — xoá cứng, bắt gõ xác nhận */}
      <Modal
        open={modal === 'delete'}
        onClose={result ? finish : close}
        title={`Xoá ${affected} tài khoản`}
        size="sm"
        footer={result ? doneFooter : formFooter(
          <Button variant="danger" size="form" loading={busy} disabled={confirmText.trim().toUpperCase() !== 'XOA'}
            onClick={() => run(() => adminApi.bulkDelete(ids))}>
            Xoá vĩnh viễn
          </Button>,
        )}
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="flex flex-col gap-4">
            <Banner tone="error" title="Không thể hoàn tác" compact>
              Xoá vĩnh viễn tài khoản và toàn bộ lịch sử điểm danh. Người đã tạo sự kiện được bỏ qua.
            </Banner>
            {summary}
            <Field label={<>Gõ <span className="font-semibold">XOA</span> để xác nhận</>}>
              {(id) => <Input id={id} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />}
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

// Một dòng "bật để ghi đè" trong form sửa hàng loạt.
function BulkField({ label, state, onToggle, children }) {
  return (
    <div className="rounded-xl bg-background p-3">
      <Checkbox label={label} checked={state.on} onChange={(e) => onToggle(e.target.checked)} labelClassName="font-medium" />
      {state.on && <div className="mt-3">{children}</div>}
    </div>
  );
}

export { MAX_BULK };
