export async function openReceiptPrintDialog() {
  const desktop = window.restaurantDesktop;
  if (!desktop) {
    window.print();
    return;
  }
  const result = await desktop.printReceipt();
  if (!result.ok) throw new Error(result.error);
}

export async function waitForDesktopServiceRecovery() {
  const desktop = window.restaurantDesktop;
  if (!desktop) return false;
  const result = await desktop.waitForServiceRecovery();
  if (!result.ok) throw new Error(result.error);
  return true;
}
