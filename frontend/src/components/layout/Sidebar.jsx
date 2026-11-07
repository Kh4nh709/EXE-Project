import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  CalendarDays, ChevronsUpDown, ClipboardList, GraduationCap, House, LayoutDashboard,
  LogOut, Monitor, Moon, ShieldAlert, Sun, Users,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import Avatar from '../ui/Avatar';
import { ProductBrand } from '../ui/Logo';
import Dropdown, { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from '../ui/Dropdown';
import { roleLabel } from '../ui/Badge';
import { cx } from '../../utils/cx';

const STAFF = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Tổng quan' },
  { to: '/events', icon: CalendarDays, label: 'Sự kiện' },
  { to: '/classes', icon: GraduationCap, label: 'Lớp học' },
  { to: '/feedback-templates', icon: ClipboardList, label: 'Mẫu đánh giá' },
];

export const NAV = {
  ADMIN: [...STAFF, { to: '/admin/users', icon: Users, label: 'Người dùng' }, { to: '/reports/fraud', icon: ShieldAlert, label: 'Log gian lận' }],
  BTC: [...STAFF, { to: '/reports/fraud', icon: ShieldAlert, label: 'Log gian lận' }],
  LECTURER: [
    { to: '/dashboard', icon: House, label: 'Trang chủ' },
    { to: '/events', icon: CalendarDays, label: 'Sự kiện' },
  ],
};

// Mục đang chọn: trang hiện tại hoặc trang con của nó (/events/123 vẫn sáng mục Sự kiện)
export function isActivePath(pathname, to) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

// Dòng vai trò ở đầu menu tài khoản (chỉ nhân sự có tài khoản)
export const accountRole = (user) => roleLabel(user?.role);

// Menu tài khoản: vai trò + email, giao diện Sáng/Tối/Theo hệ thống, đăng xuất (đỏ khi rê)
export function AccountMenuItems() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const email = user?.email || '';
  const at = email.indexOf('@');
  const handleLogout = () => {
    logout();
    navigate('/login');
  };
  return (
    <>
      <MenuGroup>
        <div className="px-3 py-2">
          <p className="text-xs text-muted">{accountRole(user)}</p>
          {email && (
            <p className="flex min-w-0 text-xs text-muted" title={email}>
              <span className="min-w-0 truncate">{at > 0 ? email.slice(0, at) : email}</span>
              {at > 0 && <span className="max-w-full shrink-0 truncate">{email.slice(at)}</span>}
            </p>
          )}
        </div>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuLabel>Giao diện</MenuLabel>
        <MenuItem icon={Sun} checked={theme === 'light'} onSelect={() => setTheme('light')}>Sáng</MenuItem>
        <MenuItem icon={Moon} checked={theme === 'dark'} onSelect={() => setTheme('dark')}>Tối</MenuItem>
        <MenuItem icon={Monitor} checked={theme === 'system'} onSelect={() => setTheme('system')}>Theo hệ thống</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuItem icon={LogOut} danger onSelect={handleLogout}>Đăng xuất</MenuItem>
      </MenuGroup>
    </>
  );
}

// Ruột sidebar (dùng chung cho cột trái ở màn rộng và panel trượt ở màn hẹp)
export default function SidebarContent({ activeNav, onNavigate }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const items = NAV[user?.role] || [];
  const current = activeNav || pathname;

  return (
    <>
      <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
        <Link to="/dashboard" onClick={onNavigate} className="outline-none">
          <ProductBrand />
        </Link>
      </div>
      <nav aria-label="Điều hướng chính" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {items.map(({ to, icon: Icon, label }) => {
          const active = isActivePath(current, to);
          return (
            <Link
              key={to}
              to={to}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 text-sm outline-none transition-colors',
                active ? 'bg-primary font-medium text-primary-foreground' : 'text-foreground/70 hover:bg-item-hover hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="shrink-0 p-3">
        <Dropdown
          align="start"
          placement="top"
          matchWidth
          width="min-w-0"
          ariaLabel="Tài khoản"
          trigger={(
            <button
              type="button"
              className="flex h-10 w-full cursor-pointer items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-xl px-1 text-left outline-none hover:bg-item-hover aria-expanded:bg-item-hover"
            >
              <Avatar name={user?.name} ring={false} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{user?.name}</span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
            </button>
          )}
        >
          <AccountMenuItems />
        </Dropdown>
      </div>
    </>
  );
}
