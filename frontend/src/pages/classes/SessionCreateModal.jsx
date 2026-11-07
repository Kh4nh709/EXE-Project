import { useState, useEffect, useId } from 'react';
import { LocateFixed } from 'lucide-react';
import toast from 'react-hot-toast';
import { classApi } from '../../services/api';
import { getCurrentPosition, GPS_ERROR_MESSAGES } from '../../utils/gps';
import { toLocalInput, localInputToISO } from '../../utils/date';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { Switch } from '../../components/ui/Choice';
import { Banner } from '../../components/ui/States';
import DateTimePicker from '../../components/ui/DateTimePicker';

function defaultForm() {
  return {
    name: '',
    location: '',
    lat: '', lng: '', radius: '100', gpsEnabled: false,
    // Mặc định để trống — buổi học không cần đặt lịch, tạo xong là mở điểm
    // danh ngay (xem backend: không có giờ nào thì checkinState tự thành OPEN).
    checkinOpen: '', checkinClose: '', checkoutOpen: '', checkoutClose: '',
  };
}

function scheduleDefaults() {
  const now = new Date();
  const plus = (mins) => toLocalInput(new Date(now.getTime() + mins * 60000).toISOString());
  return {
    checkinOpen: toLocalInput(now.toISOString()),
    checkinClose: plus(15),
    checkoutOpen: plus(15),
    checkoutClose: plus(120),
  };
}

const TIME_FIELDS = [
  { key: 'checkinOpen', label: 'Check-in mở' },
  { key: 'checkinClose', label: 'Check-in đóng' },
  { key: 'checkoutOpen', label: 'Check-out mở' },
  { key: 'checkoutClose', label: 'Check-out đóng' },
];

function SettingRow({ id, title, desc, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="text-sm font-medium text-foreground">{title}</p>
        {desc && <p className="mt-1 text-pretty text-sm text-muted">{desc}</p>}
      </div>
      <div className="pt-0.5"><Switch checked={checked} onChange={onChange} labelledBy={id} /></div>
    </div>
  );
}

export default function SessionCreateModal({ open, classId, className, onClose, onCreated }) {
  const uid = useId();
  const [form, setForm] = useState(defaultForm());
  const [useSchedule, setUseSchedule] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Reset lại form mỗi lần mở để không giữ dữ liệu buổi trước (địa điểm, giờ,
  // GPS...) sang buổi mới.
  useEffect(() => {
    if (open) { setForm(defaultForm()); setUseSchedule(false); }
  }, [open]);

  // Bật "Đặt lịch cố định" thì gợi ý sẵn khung giờ hợp lý; tắt thì xoá sạch để
  // không lỡ gửi giờ cũ lên server.
  const toggleSchedule = () => {
    const next = !useSchedule;
    setUseSchedule(next);
    setForm((f) => ({
      ...f,
      ...(next ? scheduleDefaults() : { checkinOpen: '', checkinClose: '', checkoutOpen: '', checkoutClose: '' }),
    }));
  };

  const handleDetectLocation = async () => {
    setGpsLoading(true);
    try {
      const pos = await getCurrentPosition();
      setForm((f) => ({ ...f, lat: pos.lat.toFixed(6), lng: pos.lng.toFixed(6) }));
      toast.success('Đã lấy vị trí thành công!');
    } catch (err) {
      toast.error(GPS_ERROR_MESSAGES[err.message] || 'Không lấy được vị trí');
    } finally {
      setGpsLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.location.trim()) return toast.error('Vui lòng nhập địa điểm');
    if (useSchedule && (!form.checkinOpen || !form.checkinClose || !form.checkoutOpen || !form.checkoutClose)) {
      return toast.error('Đã bật đặt lịch cố định thì cần điền đầy đủ cả 4 mốc giờ');
    }
    if (form.gpsEnabled && (!form.lat || !form.lng)) {
      return toast.error('Vui lòng lấy vị trí GPS hoặc tắt tính năng GPS');
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        name: form.name.trim() || undefined,
        checkinOpen: useSchedule ? localInputToISO(form.checkinOpen) : null,
        checkinClose: useSchedule ? localInputToISO(form.checkinClose) : null,
        checkoutOpen: useSchedule ? localInputToISO(form.checkoutOpen) : null,
        checkoutClose: useSchedule ? localInputToISO(form.checkoutClose) : null,
      };
      const { data } = await classApi.createSession(classId, payload);
      onCreated?.(data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Tạo buổi điểm danh thất bại');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Tạo buổi điểm danh — ${className}`}
      size="lg"
      footer={(
        <>
          <Button variant="secondary" size="form" onClick={onClose}>Huỷ</Button>
          <Button type="submit" form="session-create-form" variant="primary" size="form" loading={saving}>Tạo buổi điểm danh và mở QR</Button>
        </>
      )}
    >
      {open && (
        <form id="session-create-form" onSubmit={handleSubmit} className="flex flex-col gap-5">
          <Banner tone="info" compact>
            Toàn bộ danh sách lớp <span className="font-medium text-foreground">{className}</span> sẽ được thêm vào danh sách
            tham gia. {useSchedule ? 'Điểm danh mở/đóng theo khung giờ bên dưới.' : 'Điểm danh mở ngay sau khi tạo.'}
          </Banner>

          <Field label="Tên buổi học" optional hint="Để trống sẽ tự đặt tên theo ngày giờ check-in mở">
            {(id) => <Input id={id} placeholder={`VD: ${className} - Buổi 12`} value={form.name} onChange={(e) => set('name', e.target.value)} />}
          </Field>

          <Field label="Địa điểm" required>
            {(id) => <Input id={id} placeholder="VD: Phòng A101" value={form.location} onChange={(e) => set('location', e.target.value)} />}
          </Field>

          <section className="border-t border-border pt-5">
            <SettingRow
              id={`${uid}-lich`}
              title="Đặt lịch cố định"
              desc={useSchedule ? undefined : 'Điểm danh mở ngay khi tạo, không giới hạn giờ.'}
              checked={useSchedule}
              onChange={toggleSchedule}
            />
            {useSchedule && (
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {TIME_FIELDS.map(({ key, label }) => (
                  <Field key={key} label={label} required>
                    {(id) => <DateTimePicker id={id} label={label} value={form[key]} onChange={(v) => set(key, v)} clearable={false} />}
                  </Field>
                ))}
              </div>
            )}
          </section>

          <section className="border-t border-border pt-5">
            <SettingRow
              id={`${uid}-gps`}
              title="Xác thực GPS"
              desc="Sinh viên phải đứng trong bán kính cho phép mới check-in được."
              checked={form.gpsEnabled}
              onChange={(on) => set('gpsEnabled', on)}
            />
            {form.gpsEnabled && (
              <div className="mt-5 flex flex-col gap-4">
                <div>
                  <Button icon={LocateFixed} loading={gpsLoading} onClick={handleDetectLocation}>Lấy vị trí hiện tại</Button>
                </div>
                <div className="grid gap-5 sm:grid-cols-3">
                  <Field label="Vĩ độ">
                    {(id) => <Input id={id} type="number" step="any" inputMode="decimal" className="tabular-nums" value={form.lat} onChange={(e) => set('lat', e.target.value)} />}
                  </Field>
                  <Field label="Kinh độ">
                    {(id) => <Input id={id} type="number" step="any" inputMode="decimal" className="tabular-nums" value={form.lng} onChange={(e) => set('lng', e.target.value)} />}
                  </Field>
                  <Field label="Bán kính (m)">
                    {(id) => <Input id={id} type="number" min="50" max="1000" inputMode="numeric" className="tabular-nums" value={form.radius} onChange={(e) => set('radius', e.target.value)} />}
                  </Field>
                </div>
              </div>
            )}
          </section>
        </form>
      )}
    </Modal>
  );
}
