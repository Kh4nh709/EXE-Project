import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, CircleCheck, QrCode } from 'lucide-react';
import { format } from 'date-fns';
import { publicApi } from '../../services/api';
import Button from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input } from '../../components/ui/Input';
import { Banner, Skeleton } from '../../components/ui/States';
import { formatNumber, longDate } from '../../utils/eventStatus';
import PublicHeader from './PublicHeader';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EventRegister() {
  const { id } = useParams();

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const [form, setForm] = useState({ name: '', mssv: '', email: '', phone: '' });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    publicApi.getEvent(id)
      .then(({ data }) => setEvent(data.data))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.name.trim().length < 2) return setError('Vui lòng nhập họ tên hợp lệ');
    if (!form.mssv.trim()) return setError('Vui lòng nhập mã số sinh viên');
    if (!EMAIL_RE.test(form.email.trim())) return setError('Email không hợp lệ');

    setSubmitting(true);
    try {
      // Người tham gia không có tài khoản: chỉ ghi tên vào danh sách của sự kiện.
      const { data } = await publicApi.register(id, form);
      setResult({
        alreadyRegistered: data.alreadyRegistered,
        emailSent: data.emailSent,
        name: data.data?.participant?.name || form.name,
        email: data.data?.participant?.email || form.email,
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Đăng ký thất bại. Vui lòng thử lại.');
    } finally {
      setSubmitting(false);
    }
  };

  let body;
  if (loading) {
    body = (
      <div className="space-y-4 rounded-2xl border border-border bg-surface p-5" aria-busy="true">
        <Skeleton className="h-5 w-3/5" /><Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-1/3" />
      </div>
    );
  } else if (notFound || !event) {
    body = (
      <div className="mx-auto max-w-md pb-16 pt-12 text-center">
        <h1 className="text-xl font-semibold text-foreground">Không tìm thấy sự kiện</h1>
        <p className="mt-2 text-pretty text-sm/6 text-muted">Link có thể đã hết hạn hoặc sự kiện đã bị gỡ.</p>
        <div className="mt-6"><Button as={Link} to="/dang-ky" variant="primary" size="form">Xem sự kiện khác</Button></div>
      </div>
    );
  } else if (result) {
    body = <SuccessCard event={event} result={result} />;
  } else {
    body = (
      <>
        <EventSummary event={event} />
        {event.registrationClosed ? (
          <section className="rounded-2xl border border-border bg-surface p-6 text-center">
            <h2 className="text-base font-semibold text-foreground">Sự kiện đã đóng đăng ký</h2>
            <p className="mt-2 text-pretty text-sm/6 text-muted">Ban tổ chức không còn nhận đăng ký trực tuyến cho sự kiện này.</p>
            <div className="mt-4"><Button as={Link} to="/dang-ky">Xem sự kiện khác</Button></div>
          </section>
        ) : (
          <Card
            title="Thông tin đăng ký"
            sub="Không cần tài khoản: đến ngày sự kiện bạn quét mã QR và nhập email này để điểm danh."
          >
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <Field label="Họ và tên">
                {(fid) => <Input id={fid} autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} />}
              </Field>
              <Field label="Mã số sinh viên">
                {(fid) => <Input id={fid} placeholder="VD: SE170001" autoComplete="off" value={form.mssv} onChange={(e) => set('mssv', e.target.value)} />}
              </Field>
              <Field label="Email">
                {(fid) => <Input id={fid} type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} />}
              </Field>
              <Field label="Số điện thoại" optional>
                {(fid) => <Input id={fid} type="tel" placeholder="0901 234 567" autoComplete="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />}
              </Field>
              {error && <Banner tone="error" compact>{error}</Banner>}
              <Button type="submit" variant="primary" size="form" loading={submitting} className="w-full">Xác nhận đăng ký</Button>
            </form>
          </Card>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader
        right={(
          <Link to="/dang-ky" className="inline-flex h-10 items-center gap-1 text-sm text-muted outline-none hover:text-foreground">
            <ChevronLeft className="size-4" aria-hidden="true" /> Sự kiện khác
          </Link>
        )}
      />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">{body}</main>
    </div>
  );
}

/* ─────────────────────────────────────── */

// Khối nhãn và giá trị: nhãn cột trái 7rem từ sm, dưới sm nhãn nằm trên giá trị
function InfoList({ rows }) {
  return (
    <dl className="space-y-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-6">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 text-pretty font-medium text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventSummary({ event }) {
  const start = event.checkinOpen ? new Date(event.checkinOpen) : null;
  const end = event.checkinClose ? new Date(event.checkinClose) : null;
  const rows = [['Địa điểm', event.location]];
  if (start) {
    rows.push(['Ngày', longDate(event.checkinOpen)]);
    rows.push(['Check-in', end ? `${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}` : format(start, 'HH:mm')]);
  } else {
    rows.push(['Thời gian', 'Ban tổ chức sẽ chủ động mở điểm danh']);
  }
  rows.push(['Đã đăng ký', `${formatNumber(event._count?.eventMembers ?? 0)} người`]);

  return (
    <Card title={event.name} titleAs="h1" sub={event.createdBy?.name ? `Tổ chức bởi ${event.createdBy.name}` : undefined}>
      {event.description && <p className="mb-4 whitespace-pre-line text-pretty text-sm text-muted">{event.description}</p>}
      <InfoList rows={rows} />
    </Card>
  );
}

function SuccessCard({ event, result }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-6">
      <div className="flex size-12 items-center justify-center rounded-full bg-success-bg text-success">
        <CircleCheck className="size-6" aria-hidden="true" />
      </div>
      <h1 className="mt-4 text-xl font-semibold text-foreground">
        {result.alreadyRegistered ? 'Bạn đã đăng ký rồi' : 'Đăng ký thành công'}
      </h1>
      <p className="mt-2 text-pretty text-sm/6 text-muted">
        {result.alreadyRegistered
          ? 'Tên bạn đã có sẵn trong danh sách tham gia sự kiện này.'
          : 'Tên bạn đã được thêm vào danh sách tham gia sự kiện.'}
      </p>

      <div className="mt-5 rounded-xl bg-background p-4">
        <InfoList
          rows={[
            ['Sự kiện', event.name],
            ['Thời gian', event.checkinOpen ? format(new Date(event.checkinOpen), "HH:mm 'ngày' dd/MM/yyyy") : 'Ban tổ chức sẽ chủ động mở điểm danh'],
            ['Người tham dự', `${result.name} · ${result.email}`],
          ]}
        />
      </div>

      <div className="mt-4 flex gap-3 rounded-xl border border-border bg-background p-4">
        <QrCode className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        <p className="text-pretty text-sm/6 text-foreground">
          Bạn không cần tài khoản. Đến ngày sự kiện, quét mã QR tại cửa vào rồi nhập{' '}
          <span className="font-medium">{result.email}</span> để nhận mã xác minh điểm danh.
        </p>
      </div>

      {result.emailSent === false && !result.alreadyRegistered && (
        <Banner tone="warning" compact className="mt-4">
          Đã ghi nhận đăng ký nhưng chưa gửi được email xác nhận.
        </Banner>
      )}

      <div className="mt-6 flex justify-end">
        <Button as={Link} to="/dang-ky" size="form">Đăng ký sự kiện khác</Button>
      </div>
    </section>
  );
}
