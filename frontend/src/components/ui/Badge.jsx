import {
  Check, Circle, CircleCheck, CircleDashed, CircleX, Clock, LogIn, MapPinOff, QrCode, Smartphone, TicketX,
} from 'lucide-react';
import { cx } from '../../utils/cx';

// Một bảng trạng thái cho cả app: cùng một trạng thái thì cùng nhãn, cùng màu, cùng icon ở mọi
// màn (bảng, danh sách, thẻ). Màu chỉ dùng cho trạng thái thật; vai trò dùng nhóm màu phân loại
// (tím, xanh ngọc, hồng) để không lẫn với đỏ = lỗi, xanh lá = xong.
const TONE = {
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  error: 'bg-error-bg text-error-strong',
  neutral: 'bg-neutral-bg text-neutral',
  info: 'bg-info-bg text-info',
  violet: 'bg-cat-violet-bg text-cat-violet',
  teal: 'bg-cat-teal-bg text-cat-teal',
  pink: 'bg-cat-pink-bg text-cat-pink',
};

export default function Badge({ tone = 'neutral', icon: Icon, className, children }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-black/5 dark:ring-white/10',
        TONE[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export const ATTENDANCE_STATUS = {
  REGISTERED: { tone: 'neutral', label: 'Đã đăng ký', icon: Circle },
  CHECKED_IN: { tone: 'info', label: 'Đã check-in', icon: LogIn },
  CHECKED_OUT: { tone: 'success', label: 'Đã check-out', icon: CircleCheck },
  ABSENT: { tone: 'error', label: 'Vắng', icon: CircleX },
};

export const EVENT_PHASE = {
  live: { tone: 'success', label: 'Đang diễn ra' },
  upcoming: { tone: 'neutral', label: 'Sắp diễn ra', icon: Clock },
  manual: { tone: 'neutral', label: 'Chưa đặt lịch', icon: CircleDashed },
  ended: { tone: 'neutral', label: 'Đã kết thúc', icon: Check },
};

export const ROLES = {
  ADMIN: { tone: 'violet', label: 'Admin' },
  BTC: { tone: 'teal', label: 'Ban tổ chức' },
  LECTURER: { tone: 'pink', label: 'Giảng viên' },
  // Người tham gia không có tài khoản (role STUDENT giữ tên cũ trong DB).
  STUDENT: { tone: 'neutral', label: 'Người tham gia' },
};

export const FRAUD_REASONS = {
  INVALID_QR_TOKEN: { tone: 'warning', label: 'QR hết hạn hoặc giả', icon: QrCode },
  INVALID_SCAN_TICKET: { tone: 'warning', label: 'Vé quét không hợp lệ', icon: TicketX },
  GPS_OUT_OF_RANGE: { tone: 'error', label: 'Ngoài phạm vi GPS', icon: MapPinOff },
  GPS_INVALID: { tone: 'error', label: 'GPS không hợp lệ', icon: MapPinOff },
  UNBOUND_DEVICE: { tone: 'error', label: 'Thiết bị lạ', icon: Smartphone },
};

const fromMap = (map, key) => map[key] || { tone: 'neutral', label: key };

export function AttendanceBadge({ status, className }) {
  const { tone, label, icon } = fromMap(ATTENDANCE_STATUS, status);
  return <Badge tone={tone} icon={icon} className={className}>{label}</Badge>;
}

export function PhaseBadge({ phase, className }) {
  const { tone, label, icon } = fromMap(EVENT_PHASE, phase);
  return <Badge tone={tone} icon={icon} className={className}>{label}</Badge>;
}

export function RoleBadge({ role, className }) {
  const { tone, label } = fromMap(ROLES, role);
  return <Badge tone={tone} className={className}>{label}</Badge>;
}

export function FraudBadge({ reason, className }) {
  const { tone, label, icon } = fromMap(FRAUD_REASONS, reason);
  return <Badge tone={tone} icon={icon} className={className}>{label}</Badge>;
}

export const roleLabel = (role) => ROLES[role]?.label || role;
