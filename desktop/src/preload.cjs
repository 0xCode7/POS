const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restaurantDesktop', {
  printReceipt: () => ipcRenderer.invoke('receipt:print'),
  restart: () => ipcRenderer.invoke('app:restart'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  waitForServiceRecovery: () =>
    ipcRenderer.invoke('app:wait-for-service-recovery'),
});
