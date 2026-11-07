import { useId, useState } from 'react';
import { Globe, LocateFixed, Mail, QrCode } from 'lucide-react';
import toast from 'react-hot-toast';
import Button from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Textarea } from '../../components/ui/Input';
import { Checkbox, Switch } from '../../components/ui/Choice';
import DateTimePicker from '../../components/ui/DateTimePicker';
import { getCurrentPosition, GPS_ERROR_MESSAGES, reverseGeocode } from '../../utils/gps';
import { cx } from '../../utils/cx';

const TIME_FIELDS = [
  { key: 'checkinOpen', label: 'Check-in mở' },
  { key: 'checkinClose', label: 'Check-in đóng' },
  { key: 'checkoutOpen', label: 'Check-out mở' },
  { key: 'checkoutClose', label: 'Check-out đóng' },
];

// Một mục của form: ở trang tạo là card riêng; trong modal sửa là khối có tiêu đề, ngăn bằng
// đường kẻ (không card lồng trong modal).
function Section({ inModal, title, children }) {
  if (!inModal) return <Card title={title}>{children}</Card>;
  return (
    <section className="border-t border-border pt-5 first:border-0 first:pt-0">
      <h3 className="mb-4 text-base font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function SettingRow({ id, title, desc, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-pretty text-sm text-muted">{desc}</p>
      </div>
      <div className="pt-0.5">
        <Switch checked={checked} onChange={onChange} labelledBy={id} />
      </div>
    </div>
  );
}

const KINDS = [
  {
    value: 'STANDARD',
    icon: QrCode,
    title: 'Điểm danh bằng QR',
    desc: 'Người tham dự tự quét mã QR trên màn chiếu bằng tài khoản của mình, có kiểm tra GPS.',
  },
  {
    value: 'INVITATION',
    icon: Mail,
    title: 'Thiệp mời',
    desc: 'Gửi thiệp có mã QR riêng cho khách ngoài (không cần tài khoản). BTC quét thiệp khi khách tới.',
  },
  {
    value: 'PUBLIC',
    icon: Globe,
    title: 'Check-in công khai',
    desc: 'QR cố định chiếu tại sự kiện. Người ghé thăm tự quét và điền form BTC dựng, không cần tài khoản.',
  },
];

// Chọn kiểu sự kiện — chỉ có ở trang tạo; kiểu không đổi được sau khi tạo.
function KindPicker({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Kiểu sự kiện" className="grid gap-3 sm:grid-cols-3">
      {KINDS.map(({ value: v, icon: Icon, title, desc }) => {
        const selected = value === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(v)}
            className={cx(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus',
              selected ? 'border-primary bg-primary/5' : 'border-border-strong bg-surface hover:bg-surface-hover',
            )}
          >
            <Icon className={cx('mt-0.5 size-5 shrink-0', selected ? 'text-primary' : 'text-muted')} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{title}</span>
              <span className="mt-1 block text-pretty text-sm text-muted">{desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Các trường của sự kiện, dùng chung cho trang Tạo sự kiện và modal Sửa sự kiện (một form, hai
// chỗ dùng, không lệch nhau). form/setForm do trang gọi giữ; kiểm tra và gửi cũng ở trang gọi.
// "Đặt lịch tự động" tắt là xoá cả bốn mốc (luật cũ: đủ bốn mốc hoặc để trống hết).
// Sự kiện thiệp mời (form.kind = INVITATION) chỉ có thông tin cơ bản + giờ bắt đầu: không GPS,
// không cổng điểm danh, không tự đăng ký. canPickKind: chỉ trang tạo mới chọn được kiểu.
export default function EventFormFields({ form, setForm, inModal = false, canPickKind = false }) {
  const uid = useId();
  const [gpsLoading, setGpsLoading] = useState(false);
  const [detectedAddress, setDetectedAddress] = useState('');
  const [scheduleOn, setScheduleOn] = useState(() => TIME_FIELDS.some(({ key }) => form[key]));

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Check-in công khai không có check-out: chỉ hai mốc check-in.
  const isPublic = form.kind === 'PUBLIC';
  const timeFields = isPublic ? TIME_FIELDS.slice(0, 2) : TIME_FIELDS;

  const toggleSchedule = (on) => {
    setScheduleOn(on);
    if (!on) setForm((f) => ({ ...f, checkinOpen: '', checkinClose: '', checkoutOpen: '', checkoutClose: '' }));
  };

  const handleDetectLocation = async () => {
    setGpsLoading(true);
    setDetectedAddress('');
    try {
      const pos = await getCurrentPosition();
      setForm((f) => ({ ...f, lat: pos.lat.toFixed(6), lng: pos.lng.toFixed(6) }));
      toast.success('Đã lấy vị trí thành công!');
      // Địa chỉ tra ngầm, không chặn form
      const address = await reverseGeocode(pos.lat, pos.lng);
      if (address) setDetectedAddress(address);
    } catch (err) {
      toast.error(GPS_ERROR_MESSAGES[err.message] || 'Không lấy được vị trí');
    } finally {
      setGpsLoading(false);
    }
  };

  const hasCoords = form.lat && form.lng;
  const mapsUrl = hasCoords ? `https://www.google.com/maps?q=${form.lat},${form.lng}` : null;
  const isInvitation = form.kind === 'INVITATION';

  return (
    <div className={cx('flex flex-col', inModal ? 'gap-5' : 'gap-4')}>
      {canPickKind && (
        <Section inModal={inModal} title="Kiểu sự kiện">
          <KindPicker value={form.kind || 'STANDARD'} onChange={(v) => set('kind', v)} />
          <p className="mt-3 text-pretty text-xs text-muted">Không đổi được kiểu sau khi tạo.</p>
        </Section>
      )}

      <Section inModal={inModal} title="Thông tin cơ bản">
        <div className="flex flex-col gap-5">
          <Field label="Tên sự kiện" required>
            {(id) => <Input id={id} placeholder="VD: Workshop AI 2026" value={form.name} onChange={(e) => set('name', e.target.value)} />}
          </Field>
          <Field label="Mô tả" optional>
            {(id) => (
              <Textarea id={id} rows={3} className="resize-none" value={form.description} onChange={(e) => set('description', e.target.value)} />
            )}
          </Field>
          <Field label="Địa điểm" required>
            {(id) => <Input id={id} placeholder="VD: Hội trường A1, FPT University" value={form.location} onChange={(e) => set('location', e.target.value)} />}
          </Field>
          {isInvitation && (
            <Field label="Thời gian bắt đầu" required hint="In lên thiệp mời. Trang quét thiệp dùng được bất cứ lúc nào, không khoá theo giờ.">
              {(id) => <DateTimePicker id={id} label="Thời gian bắt đầu" value={form.startsAt} onChange={(v) => set('startsAt', v)} clearable={false} />}
            </Field>
          )}
        </div>
      </Section>

      {!isInvitation && (
        <>
          <Section inModal={inModal} title={isPublic ? 'Thời gian check-in' : 'Thời gian điểm danh'}>
            <SettingRow
              id={`${uid}-lich`}
              title={isPublic ? 'Giới hạn khung giờ' : 'Đặt lịch tự động'}
              desc={isPublic
                ? 'Chỉ nhận check-in trong khoảng giờ dưới. Tắt thì nhận mọi lúc — BTC vẫn đóng tay được ở trang sự kiện.'
                : 'Cổng điểm danh tự mở, tự đóng theo bốn mốc dưới. Tắt thì BTC tự mở, đóng ở trang sự kiện.'}
              checked={scheduleOn}
              onChange={toggleSchedule}
            />
            {scheduleOn && (
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {timeFields.map(({ key, label }) => (
                  <Field key={key} label={label}>
                    {(id) => <DateTimePicker id={id} label={label} value={form[key]} onChange={(v) => set(key, v)} />}
                  </Field>
                ))}
              </div>
            )}
          </Section>

          <Section inModal={inModal} title="Xác thực vị trí (GPS)">
            <SettingRow
              id={`${uid}-gps`}
              title="Bắt buộc ở gần địa điểm"
              desc={isPublic
                ? 'Người ghé thăm phải đứng trong bán kính cho phép mới check-in được — chặn việc chụp QR gửi người ở nơi khác.'
                : 'Sinh viên phải đứng trong bán kính cho phép mới check-in được.'}
              checked={form.gpsEnabled}
              onChange={(on) => set('gpsEnabled', on)}
            />
            {form.gpsEnabled ? (
              <div className="mt-5 flex flex-col gap-4">
                <div>
                  <Button icon={LocateFixed} loading={gpsLoading} onClick={handleDetectLocation}>Lấy vị trí hiện tại của tôi</Button>
                </div>
                {(detectedAddress || hasCoords) && (
                  <div className="rounded-xl bg-background p-3 text-sm">
                    {detectedAddress && <p className="text-pretty text-foreground">{detectedAddress}</p>}
                    <p className={cx('flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted', detectedAddress && 'mt-1')}>
                      {form.lat}, {form.lng}
                      {mapsUrl && (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="relative font-sans font-medium text-foreground underline-offset-4 before:absolute before:-inset-x-1.5 before:-inset-y-2 hover:underline"
                        >
                          Xem bản đồ
                        </a>
                      )}
                    </p>
                  </div>
                )}
                <div className="grid gap-5 sm:grid-cols-3">
                  <Field label="Vĩ độ" required>
                    {(id) => (
                      <Input id={id} type="number" step="any" inputMode="decimal" placeholder="10.8495" className="tabular-nums"
                        value={form.lat} onChange={(e) => { set('lat', e.target.value); setDetectedAddress(''); }} />
                    )}
                  </Field>
                  <Field label="Kinh độ" required>
                    {(id) => (
                      <Input id={id} type="number" step="any" inputMode="decimal" placeholder="106.7740" className="tabular-nums"
                        value={form.lng} onChange={(e) => { set('lng', e.target.value); setDetectedAddress(''); }} />
                    )}
                  </Field>
                  <Field label="Bán kính (m)" hint="Tối thiểu 50 m. Trong nhà nên đặt 150–200 m.">
                    {(id) => (
                      <Input id={id} type="number" min="50" max="1000" inputMode="numeric" className="tabular-nums"
                        value={form.radius} onChange={(e) => set('radius', e.target.value)} />
                    )}
                  </Field>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-pretty text-sm text-muted">
                {isPublic
                  ? 'GPS tắt — ai có QR (kể cả ảnh chụp) đều check-in được trong giờ mở cổng.'
                  : 'GPS tắt — chỉ chống gian lận bằng Dynamic QR + Device Binding.'}
              </p>
            )}
          </Section>

          {!isPublic && (
            <Section inModal={inModal} title="Người tham dự">
              <div className="flex flex-col gap-4">
                <Checkbox
                  label="Cho phép tự đăng ký tham gia"
                  desc="Người ngoài tự điền họ tên, MSSV, email qua link công khai để vào danh sách."
                  checked={form.allowRegistration}
                  onChange={(e) => set('allowRegistration', e.target.checked)}
                />
                <Checkbox
                  label="Chỉ cho phép danh sách đã đăng ký"
                  desc="Bật thì chỉ người trong danh sách tham gia mới check-in được."
                  checked={form.isWhitelisted}
                  onChange={(e) => set('isWhitelisted', e.target.checked)}
                />
                <Checkbox
                  label="Cho phép check-in bằng email (quét QR)"
                  desc="Người tham gia quét QR, nhập email, nhận mã 6 số qua email là check-in được. Mỗi điện thoại chỉ check-in cho một người. Tắt thì chỉ check-in bằng khuôn mặt hoặc BTC điểm danh tay."
                  checked={form.otpCheckinEnabled !== false}
                  onChange={(e) => set('otpCheckinEnabled', e.target.checked)}
                />
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
