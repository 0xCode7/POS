export {};

declare global {
  interface Window {
    restaurantDesktop?: {
      printReceipt(): Promise<
        | { ok: true; status: 'submitted' }
        | { ok: false; error: string; cancelled?: boolean }
      >;
      restart(): Promise<{ ok: true } | { ok: false; error: string }>;
      openLogs(): Promise<{ ok: true } | { ok: false; error: string }>;
      reportApiDiagnostic(input: {
        path: string;
        kind: 'request' | 'response' | 'network-error';
        status?: number;
      }): void;
      waitForServiceRecovery(): Promise<
        { ok: true } | { ok: false; error: string }
      >;
    };
  }
}
