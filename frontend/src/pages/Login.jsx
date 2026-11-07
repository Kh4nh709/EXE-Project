import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Activity, ArrowLeft, MapPin, QrCode, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/ui/Button';
import Logo from '../components/ui/Logo';
import OtpInput from '../components/ui/OtpInput';
import { Field, Input, PasswordInput } from '../components/ui/Input';

const features = [
  { icon: QrCode, title: 'QR đổi mỗi 30 giây', desc: 'Mã ký HMAC, chụp gửi bạn là hết hạn' },
  { icon: MapPin, title: 'Xác thực GPS', desc: 'Chỉ check-in được trong bán kính cho phép' },
  { icon: Activity, title: 'Cập nhật tức thì', desc: 'Danh sách điểm danh và báo cáo theo thời gian thực' },
  { icon: Users, title: 'Người tham gia không cần tài khoản', desc: 'Quét QR, nhập email, nhận mã là điểm danh xong' },
];

const AUTH_INPUT = 'h-12 md:h-12';

// Tiêu đề + câu dẫn của từng bước
function StepHead({ title, children }) {
  return (
    <>
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {children && <p className="mt-2 text-pretty text-sm/6 text-muted">{children}</p>}
    </>
  );
}

// Dòng lỗi luôn giữ chỗ (min-h-5): lỗi hiện ra không đẩy nút xuống dưới con trỏ
function ErrorLine({ message }) {
  return <p role="alert" className="min-h-5 text-sm text-error-text">{message}</p>;
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const [step, setStepState] = useState('login');
  const [loading, setLoading] = useState(false);
  const [otpData, setOtpData] = useState(null);
  const [error, setError] = useState('');

  const [form,    setForm]    = useState({ identifier: '', password: '' });
  const [otp,     setOtp]     = useState('');
  const [newPass, setNewPass] = useState({ current: '', new: '', confirm: '' });
  // Quên mật khẩu: identifier được giữ lại qua bước nhập mã vì API reset cần
  // gửi kèm (backend không trả về userId để tránh dò tài khoản tồn tại).
  const [forgotId,  setForgotId]  = useState('');
  const [resetForm, setResetForm] = useState({ otp: '', new: '', confirm: '' });

  const redirectTo = new URLSearchParams(location.search).get('redirect') || '/dashboard';

  // Đổi bước thì xoá câu lỗi của bước trước
  const setStep = (next) => { setError(''); setStepState(next); };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!form.identifier || !form.password) return setError('Vui lòng nhập đầy đủ thông tin');
    setError('');
    setLoading(true);
    try {
      const { data } = await authApi.login(form);
      if (data.requireOtp) {
        setOtpData({ userId: data.userId });
        setStep('otp');
        toast.success(data.message);
      } else if (data.success) {
        login(data.token, data.user);
        data.user.isFirstLogin ? setStep('change-password') : navigate(redirectTo, { replace: true });
      }
    } catch (err) {
      // Sai mật khẩu: xoá ô mật khẩu để gõ lại ngay, giữ email
      setForm((f) => ({ ...f, password: '' }));
      setError(err.response?.data?.message || 'Đăng nhập thất bại');
    } finally {
      setLoading(false);
    }
  };

  const handleOtp = async (e) => {
    e.preventDefault();
    if (otp.length !== 6) return setError('Mã OTP gồm 6 chữ số');
    setError('');
    setLoading(true);
    try {
      const { data } = await authApi.verifyOtp({ userId: otpData.userId, otp });
      if (data.success) { login(data.token, data.user); navigate(redirectTo, { replace: true }); }
    } catch (err) {
      setOtp('');
      setError(err.response?.data?.message || 'Mã OTP không đúng');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (!forgotId.trim()) return setError('Vui lòng nhập email');
    setError('');
    setLoading(true);
    try {
      const { data } = await authApi.forgotPassword({ identifier: forgotId.trim() });
      toast.success(data.message);
      setStep('reset');
    } catch (err) {
      setError(err.response?.data?.message || 'Không gửi được mã đặt lại mật khẩu');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (resetForm.otp.length !== 6) return setError('Mã xác thực gồm 6 chữ số');
    if (resetForm.new.length < 6) return setError('Mật khẩu mới phải ít nhất 6 ký tự');
    if (resetForm.new !== resetForm.confirm) return setError('Mật khẩu xác nhận không khớp');
    setError('');
    setLoading(true);
    try {
      await authApi.resetPassword({
        identifier: forgotId.trim(),
        otp: resetForm.otp,
        newPassword: resetForm.new,
      });
      toast.success('Đặt lại mật khẩu thành công! Hãy đăng nhập lại.');
      setForm({ identifier: forgotId.trim(), password: '' });
      setResetForm({ otp: '', new: '', confirm: '' });
      setStep('login');
    } catch (err) {
      setResetForm((r) => ({ ...r, otp: '' }));
      setError(err.response?.data?.message || 'Mã xác thực không đúng hoặc đã hết hạn');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPass.new !== newPass.confirm) return setError('Mật khẩu xác nhận không khớp');
    if (newPass.new.length < 6) return setError('Mật khẩu mới phải ít nhất 6 ký tự');
    setError('');
    setLoading(true);
    try {
      await authApi.changePassword({ currentPassword: newPass.current, newPassword: newPass.new });
      toast.success('Đổi mật khẩu thành công!');
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Lỗi đổi mật khẩu');
    } finally {
      setLoading(false);
    }
  };

  const backButton = (label, onClick) => (
    <Button variant="ghost" size="auth" icon={ArrowLeft} onClick={onClick} className="w-full">{label}</Button>
  );

  let content;
  if (step === 'login') {
    content = (
      <>
        <StepHead title="Đăng nhập">
          Dành cho Ban tổ chức và quản trị viên. Người tham gia không cần tài khoản: chỉ cần quét mã QR tại sự kiện.
        </StepHead>
        <form onSubmit={handleLogin} className="mt-6 flex flex-col gap-4">
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                className={AUTH_INPUT}
                placeholder="Nhập email"
                autoComplete="username"
                value={form.identifier}
                invalid={Boolean(error)}
                onChange={(e) => setForm({ ...form, identifier: e.target.value })}
              />
            )}
          </Field>
          <div className="relative flex flex-col gap-1.5">
            <label htmlFor="login-password" className="w-fit cursor-pointer text-sm font-medium text-foreground">Mật khẩu</label>
            <PasswordInput
              id="login-password"
              className={AUTH_INPUT}
              placeholder="Nhập mật khẩu"
              autoComplete="current-password"
              value={form.password}
              invalid={Boolean(error)}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button
              type="button"
              onClick={() => { setForgotId(form.identifier); setStep('forgot'); }}
              className="absolute right-0 top-0 text-sm text-foreground outline-none before:absolute before:-inset-x-2 before:-inset-y-2.5 hover:underline"
            >
              Quên mật khẩu?
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <ErrorLine message={error} />
            <Button type="submit" variant="primary" size="auth" loading={loading} className="w-full">
              Đăng nhập
            </Button>
          </div>
        </form>
      </>
    );
  } else if (step === 'otp') {
    content = (
      <form onSubmit={handleOtp}>
        <StepHead title="Xác thực thiết bị">Thiết bị này chưa được tin cậy. Mã OTP 6 chữ số đã được gửi đến email của bạn.</StepHead>
        <fieldset className="mt-6">
          <legend className="mb-2 text-sm font-medium text-foreground">Mã xác thực</legend>
          <OtpInput value={otp} onChange={(v) => { setOtp(v); if (error) setError(''); }} invalid={Boolean(error)} idPrefix="device-otp" />
          <p aria-live="polite" className="mt-2 min-h-4 text-xs text-error-text">{error}</p>
        </fieldset>
        <div className="mt-4 flex flex-col gap-2">
          <Button type="submit" variant="primary" size="auth" loading={loading} className="w-full">Xác thực</Button>
          {backButton('Quay lại đăng nhập', () => { setStep('login'); setOtp(''); })}
        </div>
      </form>
    );
  } else if (step === 'forgot') {
    content = (
      <>
        <StepHead title="Quên mật khẩu">Nhập email tài khoản để nhận mã xác thực.</StepHead>
        <form onSubmit={handleForgot} className="mt-6 flex flex-col gap-4">
          <Field label="Email">
            {(id) => (
              <Input id={id} className={AUTH_INPUT} placeholder="Nhập email" autoComplete="username"
                value={forgotId} invalid={Boolean(error)} onChange={(e) => setForgotId(e.target.value)} />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <ErrorLine message={error} />
            <Button type="submit" variant="primary" size="auth" loading={loading} className="w-full">Gửi mã xác thực</Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep('login')}>Quay lại đăng nhập</Button>
            <button type="button" onClick={() => setStep('reset')} className="text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline">
              Đã có mã?
            </button>
          </div>
        </form>
      </>
    );
  } else if (step === 'reset') {
    content = (
      <form onSubmit={handleReset}>
        <StepHead title="Đặt lại mật khẩu">Nhập mã 6 chữ số trong email và chọn mật khẩu mới. Mã hiệu lực 15 phút.</StepHead>
        <fieldset className="mt-6">
          <legend className="mb-2 text-sm font-medium text-foreground">Mã xác thực</legend>
          <OtpInput value={resetForm.otp} onChange={(v) => setResetForm((r) => ({ ...r, otp: v }))} invalid={Boolean(error) && resetForm.otp.length !== 6} idPrefix="reset-otp" />
        </fieldset>
        <div className="mt-5 flex flex-col gap-4">
          <Field label="Mật khẩu mới">
            {(id) => (
              <PasswordInput id={id} className={AUTH_INPUT} placeholder="Ít nhất 6 ký tự" autoComplete="new-password"
                value={resetForm.new} onChange={(e) => setResetForm({ ...resetForm, new: e.target.value })} />
            )}
          </Field>
          <Field label="Xác nhận mật khẩu mới">
            {(id) => (
              <Input id={id} type="password" className={AUTH_INPUT} autoComplete="new-password"
                value={resetForm.confirm} onChange={(e) => setResetForm({ ...resetForm, confirm: e.target.value })} />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <ErrorLine message={error} />
            <Button type="submit" variant="primary" size="auth" loading={loading} className="w-full">Đặt lại mật khẩu</Button>
            {backButton('Gửi lại mã', () => setStep('forgot'))}
          </div>
        </div>
      </form>
    );
  } else if (step === 'change-password') {
    content = (
      <>
        <StepHead title="Đặt mật khẩu mới">Lần đăng nhập đầu tiên — hãy đặt mật khẩu cá nhân.</StepHead>
        <form onSubmit={handleChangePassword} className="mt-6 flex flex-col gap-4">
          <Field label="Mật khẩu tạm thời">
            {(id) => (
              <Input id={id} type="password" className={AUTH_INPUT} autoComplete="current-password"
                value={newPass.current} onChange={(e) => setNewPass({ ...newPass, current: e.target.value })} />
            )}
          </Field>
          <Field label="Mật khẩu mới">
            {(id) => (
              <PasswordInput id={id} className={AUTH_INPUT} placeholder="Ít nhất 6 ký tự" autoComplete="new-password"
                value={newPass.new} onChange={(e) => setNewPass({ ...newPass, new: e.target.value })} />
            )}
          </Field>
          <Field label="Xác nhận mật khẩu mới">
            {(id) => (
              <Input id={id} type="password" className={AUTH_INPUT} autoComplete="new-password"
                value={newPass.confirm} onChange={(e) => setNewPass({ ...newPass, confirm: e.target.value })} />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <ErrorLine message={error} />
            <Button type="submit" variant="primary" size="auth" loading={loading} className="w-full">Lưu và vào hệ thống</Button>
          </div>
        </form>
      </>
    );
  }

  return (
    <div className="flex min-h-screen bg-surface">
      {/* Khối thương hiệu (từ lg): giữ gradient xanh FPT Event, chữ trắng đặc */}
      <aside className="hidden w-[52%] flex-col justify-between bg-[#0B47C9] bg-[linear-gradient(135deg,#0A3BAA_0%,#1A63F0_100%)] p-10 text-white lg:flex">
        <Link to="/" className="flex w-fit items-center gap-2.5 outline-none">
          <span className="rounded-[14px] bg-white/15 p-0.5"><Logo className="size-9" /></span>
          <span className="text-base font-semibold">FPT Event</span>
        </Link>
        <div className="max-w-md">
          <h2 className="text-balance text-3xl font-bold tracking-tight">Quản lý sự kiện thông minh và hiện đại</h2>
          <p className="mt-3 text-base/7 text-white">Điểm danh tức thì bằng QR · Chống gian lận GPS · Báo cáo theo thời gian thực</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {features.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/15">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="mt-0.5 block text-sm text-white">{desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-white">© 2026 FPT University</p>
      </aside>

      <main className="flex flex-1 items-center justify-center bg-background px-4 py-10 lg:bg-surface">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex w-fit items-center gap-2.5 outline-none lg:hidden">
            <Logo className="size-10" />
            <span className="text-base font-semibold text-foreground">FPT Event</span>
          </Link>
          <div>{content}</div>
          <p className="mt-6 text-center text-xs text-muted lg:hidden">© 2026 FPT University</p>
        </div>
      </main>
    </div>
  );
}
