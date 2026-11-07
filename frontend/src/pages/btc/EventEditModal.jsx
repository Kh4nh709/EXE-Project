import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { eventApi } from '../../services/api';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { toLocalInput, localInputToISO } from '../../utils/date';
import EventFormFields from './EventFormFields';

// Sửa sự kiện: cùng một form với trang Tạo sự kiện (EventFormFields), đặt trong modal.
export default function EventEditModal({ open, event, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && event) {
      setForm({
        name: event.name || '',
        description: event.description || '',
        location: event.location || '',
        lat: event.lat ?? '',
        lng: event.lng ?? '',
        radius: event.radius ?? 100,
        gpsEnabled: event.gpsEnabled ?? true,
        checkinOpen: toLocalInput(event.checkinOpen),
        checkinClose: toLocalInput(event.checkinClose),
        checkoutOpen: toLocalInput(event.checkoutOpen),
        checkoutClose: toLocalInput(event.checkoutClose),
        isWhitelisted: event.isWhitelisted ?? false,
        allowRegistration: event.allowRegistration ?? true,
        otpCheckinEnabled: event.otpCheckinEnabled ?? true,
        kind: event.kind || 'STANDARD',
        startsAt: toLocalInput(event.startsAt),
      });
    }
    if (!open) setForm(null);
  }, [open, event]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.location) {
      return toast.error('Vui lòng điền đầy đủ thông tin bắt buộc');
    }
    // Check-in công khai: gửi cả hai mốc (null = tắt giới hạn giờ). Chỉ đổi trạng thái cổng
    // khi BTC vừa bật/tắt công tắc, để không ghi đè lần mở/đóng tay đang có.
    if (form.kind === 'PUBLIC') {
      if (Boolean(form.checkinOpen) !== Boolean(form.checkinClose)) {
        return toast.error('Giới hạn khung giờ cần đủ giờ mở và giờ đóng check-in, hoặc tắt giới hạn');
      }
      if (form.gpsEnabled && (!form.lat || !form.lng)) return toast.error('Vui lòng nhập toạ độ GPS hoặc tắt tính năng GPS');
      const hadWindow = Boolean(event.checkinOpen);
      const hasWindow = Boolean(form.checkinOpen);
      setSaving(true);
      try {
        await eventApi.update(event.id, {
          name: form.name,
          description: form.description,
          location: form.location,
          gpsEnabled: form.gpsEnabled,
          lat: form.lat,
          lng: form.lng,
          radius: form.radius,
          checkinOpen: hasWindow ? localInputToISO(form.checkinOpen) : null,
          checkinClose: hasWindow ? localInputToISO(form.checkinClose) : null,
          ...(hadWindow !== hasWindow && { checkinState: hasWindow ? 'AUTO' : 'OPEN' }),
        });
        toast.success('Cập nhật sự kiện thành công');
        onSaved?.();
        onClose();
      } catch (err) {
        toast.error(err.response?.data?.message || 'Cập nhật thất bại');
      } finally {
        setSaving(false);
      }
      return;
    }
    // Sự kiện thiệp mời chỉ sửa thông tin in trên thiệp (server cũng khoá phần còn lại).
    if (form.kind === 'INVITATION') {
      if (!form.startsAt) return toast.error('Vui lòng chọn thời gian bắt đầu');
      setSaving(true);
      try {
        await eventApi.update(event.id, {
          name: form.name, description: form.description, location: form.location, startsAt: localInputToISO(form.startsAt),
        });
        toast.success('Cập nhật sự kiện thành công');
        onSaved?.();
        onClose();
      } catch (err) {
        toast.error(err.response?.data?.message || 'Cập nhật thất bại');
      } finally {
        setSaving(false);
      }
      return;
    }
    const timeFields = [form.checkinOpen, form.checkinClose, form.checkoutOpen, form.checkoutClose];
    const filledCount = timeFields.filter(Boolean).length;
    if (filledCount > 0 && filledCount < 4) {
      return toast.error('Vui lòng điền đủ cả 4 mốc giờ, hoặc để trống tất cả để tự mở/đóng điểm danh thủ công');
    }
    if (form.gpsEnabled && (!form.lat || !form.lng)) {
      return toast.error('Vui lòng nhập toạ độ GPS hoặc tắt tính năng GPS');
    }
    setSaving(true);
    try {
      const { kind, startsAt, ...rest } = form; // eslint-disable-line no-unused-vars
      const payload = {
        ...rest,
        checkinOpen: form.checkinOpen ? localInputToISO(form.checkinOpen) : null,
        checkinClose: form.checkinClose ? localInputToISO(form.checkinClose) : null,
        checkoutOpen: form.checkoutOpen ? localInputToISO(form.checkoutOpen) : null,
        checkoutClose: form.checkoutClose ? localInputToISO(form.checkoutClose) : null,
      };
      await eventApi.update(event.id, payload);
      toast.success('Cập nhật sự kiện thành công');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cập nhật thất bại');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sửa sự kiện"
      size="lg"
      footer={(
        <>
          <Button variant="secondary" size="form" onClick={onClose}>Huỷ</Button>
          <Button type="submit" form="event-edit-form" variant="primary" size="form" loading={saving}>Lưu thay đổi</Button>
        </>
      )}
    >
      {form && (
        <form id="event-edit-form" onSubmit={handleSubmit}>
          <EventFormFields form={form} setForm={setForm} inModal />
        </form>
      )}
    </Modal>
  );
}
