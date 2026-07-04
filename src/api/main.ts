import { startApi } from './server.js';

startApi().catch((e) => {
  console.error(e);
  process.exit(1);
});
