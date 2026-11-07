import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Award, FileDown, ImageDown } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { certificateApi } from '../../services/api';
import Button from '../../components/ui/Button';
import Logo from '../../components/ui/Logo';
import { Skeleton } from '../../components/ui/States';
import CertificateCanvas from '../certificates/CertificateCanvas';
import { downloadBlob } from '../certificates/certRender';

// Trang xem chứng nhận mở từ link trong email. Người tham gia không có tài khoản nên link
// tự mang quyền xem đúng một chứng nhận (backend lib/certificateLink.js). Xem trên web bằng
// canvas, tải PDF do server vẽ — cùng nguồn layout/font với bản PDF (lib/certificateLayout.js).
export default function CertificateView() {
  const { token } = useParams();
  const [cert, setCert] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let url = null;
    Promise.all([certificateApi.getByLink(token), certificateApi.backgroundByLink(token)])
      .then(([info, bg]) => {
        if (cancelled) return;
        url = URL.createObjectURL(bg.data);
        setCert(info.data.data);
        setImageUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.status === 404
            ? 'Link không đúng hoặc chứng nhận đã bị thu hồi.'
            : 'Không tải được chứng nhận. Vui lòng thử lại sau.');
        }
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token]);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const { data } = await certificateApi.pdfByLink(token);
      downloadBlob(data, `chung-nhan-${cert.event.name}.pdf`);
    } catch {
      toast.error('Tải chứng nhận thất bại');
    } finally {
      setDownloading(false);
    }
  };

  const downloadPng = async () => {
    const blob = await canvasRef.current?.toPngBlob();
    if (blob) downloadBlob(blob, `chung-nhan-${cert.event.name}.png`);
  };

  const ready = cert && imageUrl;

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-6 flex items-center justify-center gap-2 text-sm text-muted">
          <Logo className="size-6" />
          <span>Chứng nhận tham gia · FPT Event</span>
        </div>

        {error ? (
          <section className="mx-auto max-w-sm rounded-2xl bg-surface p-6 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-error-bg text-error-text">
              <Award className="size-8" aria-hidden="true" />
            </div>
            <h1 className="mt-4 text-xl font-semibold text-foreground">Không mở được chứng nhận</h1>
            <p className="mt-1 text-pretty text-sm text-muted">{error}</p>
          </section>
        ) : (
          <section className="rounded-2xl bg-surface p-4 sm:p-6">
            {ready ? (
              <>
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <h1 className="text-pretty text-lg font-semibold text-foreground">{cert.event.name}</h1>
                    <p className="mt-1 text-sm text-muted">
                      Cấp ngày {format(new Date(cert.issuedAt), 'dd/MM/yyyy')} · <span className="font-mono">{cert.code}</span>
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex">
                    <Button size="form" icon={ImageDown} onClick={downloadPng}>Tải ảnh PNG</Button>
                    <Button variant="primary" size="form" icon={FileDown} loading={downloading} onClick={downloadPdf}>Tải PDF</Button>
                  </div>
                </div>
                <CertificateCanvas ref={canvasRef} imageUrl={imageUrl} template={cert.template} values={cert.values} />
              </>
            ) : (
              <div aria-busy="true">
                <Skeleton className="mb-4 h-6 w-2/3" />
                <Skeleton className="aspect-[1.414] w-full rounded-xl" />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
