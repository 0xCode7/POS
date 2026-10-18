import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

export type DialogField = {
  name: string;
  label: string;
  value?: string;
  type?: 'text' | 'password' | 'number' | 'textarea' | 'select';
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
};
type DialogOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'normal' | 'danger';
  fields?: DialogField[];
};

export function useSiteDialog() {
  const [options, setOptions] = useState<DialogOptions>();
  const resolver = useRef<
    ((value: Record<string, string> | null) => void) | undefined
  >(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);

  const ask = useCallback((next: DialogOptions) => {
    return new Promise<Record<string, string> | null>((resolve) => {
      resolver.current?.(null);
      returnFocus.current = document.activeElement as HTMLElement | null;
      resolver.current = resolve;
      setOptions(next);
    });
  }, []);

  const close = useCallback((value: Record<string, string> | null) => {
    resolver.current?.(value);
    resolver.current = undefined;
    setOptions(undefined);
  }, []);

  return {
    ask,
    dialog: options ? (
      <SiteDialog
        options={options}
        onClose={close}
        returnFocusRef={returnFocus}
      />
    ) : null,
  };
}

function SiteDialog({
  options,
  onClose,
  returnFocusRef,
}: {
  options: DialogOptions;
  onClose: (value: Record<string, string> | null) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const returnTarget = returnFocusRef.current;
    const focusable = () => [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKey);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      className="site-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose(null);
      }}
    >
      <section
        ref={dialogRef}
        className="site-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-dialog-title"
      >
        <div className="site-dialog-heading">
          <span className="site-dialog-icon">
            {options.tone === 'danger' ? '!' : '✓'}
          </span>
          <div>
            <h2 id="site-dialog-title">{options.title}</h2>
            {options.message && <p>{options.message}</p>}
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            onClose(
              Object.fromEntries(
                (options.fields ?? []).map((field) => [
                  field.name,
                  String(data.get(field.name) ?? ''),
                ]),
              ),
            );
          }}
        >
          {(options.fields ?? []).map((field, index) => (
            <label key={field.name}>
              {field.label}
              {field.type === 'textarea' ? (
                <textarea
                  name={field.name}
                  defaultValue={field.value}
                  required={field.required}
                  autoFocus={index === 0}
                  rows={3}
                />
              ) : field.type === 'select' ? (
                <select
                  name={field.name}
                  defaultValue={field.value}
                  required={field.required}
                  autoFocus={index === 0}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={field.name}
                  type={field.type ?? 'text'}
                  defaultValue={field.value}
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  autoFocus={index === 0}
                />
              )}
            </label>
          ))}
          <div className="site-dialog-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => onClose(null)}
            >
              {options.cancelLabel ?? 'رجوع'}
            </button>
            <button
              type="submit"
              className={options.tone === 'danger' ? 'dialog-danger' : ''}
              autoFocus={!options.fields?.length}
            >
              {options.confirmLabel ?? 'تأكيد'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
