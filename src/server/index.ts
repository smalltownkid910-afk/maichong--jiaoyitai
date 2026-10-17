import 'dotenv/config';
import { startServer } from './app.js';

const service = await startServer();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  await service.close();
  process.exit(0);
});
