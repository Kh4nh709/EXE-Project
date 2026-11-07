import { Link } from 'react-router-dom';
import { ArrowRight, ChartColumn, Check, MapPin, QrCode, ShieldCheck, Smartphone, Users } from 'lucide-react';
import Button from '../components/ui/Button';
import Logo, { ProductBrand } from '../components/ui/Logo';
import { RoleBadge } from '../components/ui/Badge';

// Màu ô icon của từng tính năng giữ như bản cũ (mỗi tính năng một màu), bản tối dùng nền mờ
const features = [
  { icon: QrCode, title: 'QR động thông minh', desc: 'Mã tự đổi mỗi 30 giây, ký HMAC-SHA256. Chụp màn hình gửi bạn là hết hạn.', color: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300' },
  { icon: MapPin, title: 'Xác thực GPS thời gian thực', desc: 'Chỉ check-in được trong bán kính đã cấu hình quanh địa điểm.', color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' },
  { icon: ShieldCheck, title: 'Chống gian lận nhiều lớp', desc: 'Khoá thiết bị qua OTP email, kiểm mã QR, GPS và khung giờ.', color: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300' },
  { icon: ChartColumn, title: 'Báo cáo và xuất Excel', desc: 'Số liệu điểm danh theo thời gian thực, xuất Excel đủ thông tin sinh viên.', color: 'bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300' },
  { icon: Smartphone, title: 'Quét bằng điện thoại', desc: 'Dùng camera hoặc Zalo, không phải cài ứng dụng.', color: 'bg-pink-50 text-pink-600 dark:bg-pink-500/15 dark:text-pink-300' },
  { icon: Users, title: 'Người tham gia không cần tài khoản', desc: 'Ban tổ chức nhập danh sách email cho từng sự kiện; người tham gia quét QR, nhập email là điểm danh.', color: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300' },
];

const steps = [
  { title: 'BTC tạo sự kiện', desc: 'Nhập thông tin, vị trí GPS, khung giờ và danh sách tham dự.' },
  { title: 'Chiếu mã QR', desc: 'Mở màn QR toàn màn hình ở cổng vào, mã tự đổi mỗi 30 giây.' },
  { title: 'Người tham gia quét QR', desc: 'Nhập email đã đăng ký, nhận mã 6 số qua email là điểm danh xong.' },
  { title: 'Xem báo cáo', desc: 'Theo dõi điểm danh trực tiếp, xuất Excel khi kết thúc.' },
];

const highlights = [
  ['30 giây', 'QR đổi mới mỗi'],
  ['4 lớp', 'Bảo mật chống gian lận'],
  ['100%', 'Không cần cài ứng dụng'],
  ['Tức thì', 'Cập nhật điểm danh'],
];

const roles = [
  ['ADMIN', ['Quản lý tài khoản Ban tổ chức', 'Import ảnh khuôn mặt theo lô', 'Xem log gian lận', 'Reset thiết bị']],
  ['BTC', ['Tạo sự kiện, nhập danh sách tham gia', 'Chiếu mã QR, kiosk khuôn mặt', 'Xem báo cáo theo thời gian thực', 'Cấp chứng nhận, xuất Excel']],
  ['STUDENT', ['Không cần tài khoản', 'Tự đăng ký bằng họ tên, MSSV, email', 'Quét QR + mã email để check-in, check-out', 'Nhận chứng nhận qua email']],
];

// Nền thương hiệu: gradient xanh đậm, mã đặc dự phòng phía dưới, chữ trắng đặc. Nút sáng đổi sang nền
// surface ở giao diện tối để không thành mảng trắng chói giữa màn tối
const BRAND_BG = 'bg-[#0B47C9] bg-[linear-gradient(135deg,#0A3BAA_0%,#1A63F0_100%)] text-white';
const LIGHT_CTA = 'inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-[#0052D4] outline-none transition-colors hover:bg-white/90 dark:bg-surface dark:text-foreground dark:hover:bg-surface-hover';
const GHOST_CTA = 'inline-flex h-12 items-center justify-center rounded-xl border border-white/40 px-6 text-sm font-semibold text-white outline-none transition-colors hover:bg-white/10';

export default function Landing() {
  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="outline-none"><ProductBrand /></Link>
          <nav className="hidden items-center gap-6 text-sm text-foreground/70 md:flex">
            <a href="#features" className="hover:text-foreground">Tính năng</a>
            <a href="#how-it-works" className="hover:text-foreground">Cách hoạt động</a>
            <Link to="/dang-ky" className="hover:text-foreground">Đăng ký sự kiện</Link>
          </nav>
          <div className="ml-auto">
            <Button as={Link} to="/login" size="hdr">Đăng nhập</Button>
          </div>
        </div>
      </header>

      <section className={BRAND_BG}>
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-5xl">Điểm danh thông minh, không thể gian lận</h1>
            <p className="mt-4 max-w-[55ch] text-base/7 text-white">
              Hệ thống quản lý sự kiện và điểm danh cho Đại học FPT. QR động · GPS xác thực · Báo cáo theo thời gian thực.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/dang-ky" className={LIGHT_CTA}>Đăng ký tham gia sự kiện <ArrowRight className="size-4" aria-hidden="true" /></Link>
              <Link to="/login" className={GHOST_CTA}>Đăng nhập</Link>
            </div>
          </div>
          <div className="hidden justify-center lg:flex">
            <div className="rounded-[40px] bg-white/10 p-6"><Logo className="size-48" /></div>
          </div>
        </div>
        <div className="border-t border-white/15">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-4">
            {highlights.map(([n, l]) => (
              <div key={n}>
                <p className="text-xl font-semibold">{n}</p>
                <p className="mt-0.5 text-sm text-white">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">Mọi thứ bạn cần cho sự kiện</h2>
        <p className="mt-3 max-w-[55ch] text-base/7 text-muted">Từ tạo sự kiện tới báo cáo sau sự kiện, trong một nền tảng.</p>
        <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, desc, color }) => (
            <div key={title}>
              <div className={`flex size-10 items-center justify-center rounded-xl ${color}`}>
                <Icon className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
              <p className="mt-1 text-pretty text-sm/6 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 bg-background">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">Hoạt động như thế nào?</h2>
          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ title, desc }, i) => (
              <li key={title} className="rounded-2xl border border-border bg-surface p-5">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{i + 1}</span>
                <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
                <p className="mt-1 text-pretty text-sm/6 text-muted">{desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">Dành cho tất cả mọi người</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map(([role, perms]) => (
            <div key={role} className="rounded-2xl border border-border bg-surface p-5">
              <RoleBadge role={role} />
              <ul className="mt-4 space-y-2">
                {perms.map((p) => (
                  <li key={p} className="flex gap-2 text-sm text-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className={BRAND_BG}>
        <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-6">
          <h2 className="text-balance text-2xl font-bold sm:text-3xl">Sẵn sàng triển khai?</h2>
          <p className="mx-auto mt-3 max-w-[55ch] text-pretty text-base/7 text-white">
            Đăng ký tham gia sự kiện chỉ với họ tên, MSSV và email — không cần tạo tài khoản.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to="/dang-ky" className={LIGHT_CTA}>Đăng ký tham gia sự kiện <ArrowRight className="size-4" aria-hidden="true" /></Link>
            <Link to="/login" className={GHOST_CTA}>Đăng nhập hệ thống</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2"><Logo className="size-6" /><span>© 2026 FPT University</span></div>
            <Link to="/dang-ky" className="inline-flex h-10 items-center hover:text-foreground">Đăng ký tham gia sự kiện</Link>
          </div>
          <p className="mt-4 text-pretty border-t border-border pt-4">
            Sản phẩm được phát triển bởi nhóm sinh viên:{' '}
            <span className="text-foreground">
              Mai Nam Nguyên, Lê Hiếu Nghĩa, Nguyễn Trần Quế Đông, Nguyễn Huỳnh Bảo Trân và Huỳnh Nguyễn Kim Như
            </span>.
          </p>
        </div>
      </footer>
    </div>
  );
}
