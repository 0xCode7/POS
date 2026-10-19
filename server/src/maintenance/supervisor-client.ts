import net from 'node:net';

type Reply = { ok: boolean; result?: unknown; error?: string };

export class SupervisorClient {
  constructor(
    private readonly socket = process.env.POS_SUPERVISOR_SOCKET,
    private readonly secret = process.env.POS_SUPERVISOR_SECRET,
  ) {}

  get available() {
    return Boolean(this.socket && this.secret);
  }

  async request(
    method: 'status' | 'restore',
    params: Record<string, unknown> = {},
  ) {
    const socket = this.socket;
    const secret = this.secret;
    if (!socket || !secret) throw new Error('مشرف التشغيل الموثوق غير متصل.');
    return new Promise<unknown>((resolve, reject) => {
      const connection = net.createConnection(socket);
      let response = '';
      const timeout = setTimeout(() => {
        connection.destroy();
        reject(new Error('انتهت مهلة الاتصال بمشرف التشغيل.'));
      }, 5_000);
      connection.setEncoding('utf8');
      // Keep the read side of a Windows named-pipe connection open until the
      // Supervisor has replied. Calling end() here can race its reply and
      // produce EPIPE, which used to crash the Supervisor and its backend.
      connection.on('connect', () =>
        connection.write(`${JSON.stringify({ secret, method, params })}\n`),
      );
      connection.on('data', (chunk) => (response += chunk));
      connection.on('error', reject);
      connection.on('close', () => {
        clearTimeout(timeout);
        try {
          const reply = JSON.parse(response) as Reply;
          if (!reply.ok)
            reject(new Error(reply.error ?? 'فشل طلب مشرف التشغيل.'));
          else resolve(reply.result);
        } catch (error) {
          reject(new Error('رد مشرف التشغيل غير صالح.', { cause: error }));
        }
      });
    });
  }
}
