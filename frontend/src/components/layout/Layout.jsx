import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronLeft, Menu } from 'lucide-react';
import SidebarContent from './Sidebar';
import { lockScroll, unlockScroll } from '../ui/Modal';
import { cx } from '../../utils/cx';

// Khung app (chỉ nhân sự có tài khoản): cột trái 240px từ lg; dưới lg là nút ☰ mở panel trượt.
// Header 64px: tên trang (h1) hoặc đường dẫn về cấp cha khi trang có đầu trang riêng.
//   title       — tên trang trên header
//   parent      — { label, to }: thay tên trang bằng link về trang cha (trang chi tiết)
//   headerRight — nút bên phải header (nút chính của màn)
//   activeNav   — đường dẫn mục menu cần sáng khi khác trang hiện tại
export default function Layout({ title, parent, headerRight, activeNav, children }) {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerRef = useRef(null);

  // Đổi trang thì đóng panel
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    lockScroll();
    drawerRef.current?.focus({ preventScroll: true });
    const onKeyDown = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen w-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-surface dark:border-r dark:border-border lg:flex">
        <SidebarContent activeNav={activeNav} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface pl-2 pr-4 sm:pl-4 sm:pr-6 lg:pl-6">
          <button
            type="button"
            aria-label="Mở menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-foreground/70 outline-none hover:bg-foreground/5 hover:text-foreground lg:hidden"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>

          {parent ? (
            <nav aria-label="Đường dẫn" className="min-w-0">
              <Link
                to={parent.to}
                className="inline-flex h-10 max-w-48 items-center gap-1 text-sm text-muted outline-none hover:text-foreground sm:h-8"
              >
                <ChevronLeft className="size-4 shrink-0 sm:hidden" aria-hidden="true" />
                <span className="truncate">{parent.label}</span>
              </Link>
            </nav>
          ) : (
            <h1 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h1>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {headerRight}
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>

          {/* Panel trượt trái của nút ☰: 500ms vào, 350ms ra, đường cong sheet */}
          <div
            aria-hidden="true"
            onClick={() => setMenuOpen(false)}
            className={cx(
              'fixed inset-0 z-40 bg-black/15 transition-[opacity,visibility] ease-sheet lg:hidden',
              menuOpen ? 'visible opacity-100 duration-500' : 'invisible opacity-0 duration-[350ms]',
            )}
          />
          <aside
            ref={drawerRef}
            tabIndex={-1}
            aria-label="Menu"
            aria-hidden={!menuOpen}
            className={cx(
              'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[calc(100vw-56px)] flex-col bg-surface shadow-modal outline-none transition-[transform,translate,visibility] ease-sheet motion-reduce:transition-none dark:border-r dark:border-border lg:hidden',
              menuOpen ? 'visible translate-x-0 duration-500' : 'invisible -translate-x-full duration-[350ms]',
            )}
          >
            <button type="button" className="sr-only" onClick={() => setMenuOpen(false)}>Đóng menu</button>
            <SidebarContent activeNav={activeNav} onNavigate={() => setMenuOpen(false)} />
          </aside>
    </div>
  );
}
