// Loopback-only network guard for the child processes the worker suites spawn
// (`node --import ./tests/fixtures/networkGuard.js ...`, or imported first by a bootstrap). Any TCP
// connection or DNS query for a host other than this machine throws, so a test that goes wrong can
// never reach a provider, a remote database or a public resolver.
//
// The guard itself is shared with the hermetic e2e harness (scripts/e2e/lib/networkGuard.js, ADR-024);
// here it reports blocked attempts as TEST_EXTERNAL_NETWORK_BLOCKED.

import { installNetworkGuard } from "../../scripts/e2e/lib/networkGuard.js";

installNetworkGuard({ label: "TEST" });
