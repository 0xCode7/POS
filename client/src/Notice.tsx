import { useEffect } from 'react';

export function Notice({
  message,
  tone,
  onDismiss,
}: {
  message: string;
  tone: 'error' | 'success' | 'info';
  onDismiss: () => void;
}) {
  useEffect(() => {
    const delay = tone === 'success' ? 4_000 : tone === 'info' ? 6_000 : 0;
    if (!delay) return;
    const timer = window.setTimeout(onDismiss, delay);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, tone]);

  return (
    <p
      className={`${tone === 'error' ? 'form-error' : tone === 'success' ? 'success-message' : 'info-message'} page-toast`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span>{message}</span>
      <button
        type="button"
        className="notice-dismiss"
        aria-label="إغلاق الإشعار"
        onClick={onDismiss}
      >
        ×
      </button>
    </p>
  );
}
