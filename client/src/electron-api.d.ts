export {};

declare global {
  interface Window {
    restaurantDesktop?: {
      printReceipt(): Promise<{ ok: true } | { ok: false; error: string }>;
      restart(): Promise<{ ok: true } | { ok: false; error: string }>;
      openLogs(): Promise<{ ok: true } | { ok: false; error: string }>;
      waitForServiceRecovery(): Promise<
        { ok: true } | { ok: false; error: string }
      >;
    };
  }
}
