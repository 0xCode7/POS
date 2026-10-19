import { useEffect } from 'react';

export function Notice({
  message,
  tone,
  onDismiss,
}: {
  message: string;
  tone: 'error' | 'success';
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (tone !== 'success') return;
    const timer = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, tone]);

  return (
    <p
      className={`${tone === 'error' ? 'form-error' : 'success-message'} page-toast`}
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
