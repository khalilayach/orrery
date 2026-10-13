// Spawn a private mock agent server (own port + own parts folder) so a test can send
// /trace/cmd or write parts without other specs' open pages receiving them.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
    s.on('error', bad);
  });
}

export async function startMock() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'orrery-test-parts-'));
  const proc = spawn('node', ['server/agent-server.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, MOCK_CLAUDE: '1', PORT: String(port), PARTS_DIR: dir },
  });
  const api = `http://127.0.0.1:${port}`;
  let token = '';
  for (let i = 0; i < 60 && !token; i++) {
    try { token = (await (await fetch(api + '/health')).json()).token; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!token) { proc.kill(); throw new Error('mock server did not start'); }
  return { port, api, token, dir, stop() { proc.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}
