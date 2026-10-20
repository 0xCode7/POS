export type ReceiptPrintResult = 'submitted' | 'dialog-opened';

export async function openReceiptPrintDialog(): Promise<ReceiptPrintResult> {
  const desktop = window.restaurantDesktop;
  if (!desktop) {
    window.print();
    return 'dialog-opened';
  }
  const result = await desktop.printReceipt();
  if (!result.ok) throw new Error(result.error);
  return result.status;
}

export async function waitForDesktopServiceRecovery() {
  const desktop = window.restaurantDesktop;
  if (!desktop) return false;
  const result = await desktop.waitForServiceRecovery();
  if (!result.ok) throw new Error(result.error);
  return true;
}
