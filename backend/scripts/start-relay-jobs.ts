// Runs relay and jobs as one process group in one container, for platforms (Railway) that
// only accept one start command per service and don't support a volume shared between two
// separate services. Both still read/write the same /app/data volume exactly as they do
// under docker-compose's two-service layout. Either child exiting kills the other and this
// process exits non-zero, so the platform's restart policy restarts the whole pair together.
const children = [
  Bun.spawn(['bun', 'src/relay/index.ts'], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }),
  Bun.spawn(['bun', 'src/jobs/index.ts'], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
];

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const [relayExit, jobsExit] = await Promise.all(children.map((c) => c.exited));

if (!shuttingDown) {
  // One died on its own: stop the other and surface a non-zero exit so the platform restarts both.
  for (const child of children) child.kill('SIGTERM');
  process.exit(relayExit !== 0 ? relayExit : jobsExit !== 0 ? jobsExit : 1);
}

process.exit(relayExit !== 0 ? relayExit : jobsExit);

export {};
