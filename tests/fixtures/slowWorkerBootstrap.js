// Child-process worker for the worker suites (WK-4, WK-7, WK-8). It runs the REAL worker command line
// (scripts/worker.js runWorkerCli: database guard, connection, loop, signals) with every verification
// step replaced by a fake, so no provider can ever be called from the child:
//   WORKER_FIXTURE_SLOW_STEP=<step>  that step sleeps WORKER_FIXTURE_SLOW_MS (default 60 s) first
// A loopback-only network guard (tests/fixtures/networkGuard.js) backs that up: any connection to, or
// name lookup of, another host throws.
//
//   node tests/fixtures/slowWorkerBootstrap.js [--once]       (MONGO_URI must be a local mongod)

// The loopback-only guard first, before anything can open a connection.
import "./networkGuard.js";

const { setExecutor } = await import("../../services/verificationJobs.service.js");
const STEPS = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];
const slowStep = process.env.WORKER_FIXTURE_SLOW_STEP || null;
const slowMs = Number(process.env.WORKER_FIXTURE_SLOW_MS) || 60_000;
for (const step of STEPS) {
  setExecutor(step, async () => {
    if (step === slowStep) await new Promise((resolve) => setTimeout(resolve, slowMs));
    return { fixture: step };
  });
}

const { runWorkerCli } = await import("../../scripts/worker.js");
process.exit(await runWorkerCli({ argv: process.argv.slice(2) }));
