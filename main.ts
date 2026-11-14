// Entry boot: talk to the harness env, then keep the forge alive until it is done.
// --
// The env drives the whole trial. This process has four jobs: learn the env's
// origin, bind a port the kernel picks, tell the env that port, and wait for
// the env to say the suite finished. The HTTP surface itself lives in app.ts;
// this file only runs the lifecycle around it, so it stays small on purpose.
// --
//   1. MAKEFUN_ENV_URL is the env's origin (http://store:8080 inside a trial
//      pod). With no origin there is nobody to register with: exit 1 at once.
//   2. listen(0) asks the kernel for a free port. Port 8080 belongs to the
//      env, so it is never bound here.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The first register
//      wins; a 409 only means another entry already won, so this process
//      treats it as success and keeps waiting like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The
//      env answers immediately either way, so this is a poll with backoff,
//      never a held-open request.
//   5. Close the server and exit 0 once the env says done.

import { createApp } from "./app.ts";

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const die = (msg: string): never => { process.stderr.write(msg); process.exit(1); };
if (ENV_ORIGIN === "") die("[entry] MAKEFUN_ENV_URL is missing: nothing to register with\n");

// One HTTP round trip may take this long before it is abandoned and retried.
const CALL_TIMEOUT = 30_000;
// Backoff between retries: start here, double, never pass the cap.
const BACKOFF_FIRST = 250;
const BACKOFF_LIMIT = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Wait after the nth failed attempt: 250ms, 500ms, ... doubling to 2s.
const backoffMs = (n: number): number => {
  const doubled = BACKOFF_FIRST * 2 ** Math.min(n, 8);
  return doubled > BACKOFF_LIMIT ? BACKOFF_LIMIT : doubled;
};

// Announce the bound port to the env, retrying until it is accepted. 200 is
// the normal answer and 409 means a first register already won; 400 and 405
// are contract errors that end the run, and anything else is retried because
// the env may still be starting.
const announce = async (boundPort: number, tries = 0): Promise<void> => {
  const reply = await fetch(`${ENV_ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: boundPort }),
    signal: AbortSignal.timeout(CALL_TIMEOUT),
  }).catch(() => undefined);
  if (reply === undefined) { await pause(backoffMs(tries)); return announce(boundPort, tries + 1); }
  const code = reply.status;
  if (code === 200 || code === 409) return;
  if (code === 400 || code === 405) throw new Error(`register got HTTP ${code}: ${await reply.text()}`);
  await pause(backoffMs(tries));
  return announce(boundPort, tries + 1);
};

// Poll the env until it says the trial is over; never return before that.
const awaitDone = async (tries = 0): Promise<void> => {
  const reply = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT) }).catch(() => undefined);
  if (reply !== undefined && reply.ok) { const body = (await reply.json()) as { done?: unknown }; if (body.done === true) return; }
  await pause(backoffMs(tries));
  return awaitDone(tries + 1);
};

// Bind, announce, wait, shut down: the whole life of the process.
const run = async (): Promise<void> => {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, () => {
      const addr = forge.address();
      if (addr === null || typeof addr === "string") reject(new Error("the server bound no TCP port"));
      else resolve(addr.port);
    }); });
  process.stdout.write(`[entry] up on port ${port}\n`);
  await announce(port);
  process.stdout.write("[entry] announced; waiting for done\n");
  await awaitDone();
  forge.close(); process.stdout.write("[entry] done\n");
};

const fail = (err: unknown): void => { process.stderr.write(`[entry] failed: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); };
run().then(() => process.exit(0), fail);
