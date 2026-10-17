// DS-3 child process: load the app with the environment this process was started with, then report
// what /__dev/storage answers (unsigned PUT and GET) as one JSON line. No database is connected and no
// request leaves 127.0.0.1 (run it with --import ./tests/fixtures/networkGuard.js).
import http from "node:http";

const { default: app } = await import("../../app.js");
const { isDevStorageReceiverEnabled } = await import("../../config/env.js");
const { signAccessToken } = await import("../../utils/token.js");
// Authenticated, so "not mounted" is the router's 404 rather than the auth middleware's 401.
const auth = { Authorization: `Bearer ${signAccessToken({ cognitoSub: "ds3-probe", email: "ds3@example.com" })}` };
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = "uploads/claims/0123456789abcdef01234567/img_00000000-0000-4000-8000-000000000000/image.png";
const put = await fetch(`${base}/__dev/storage/${key}?ct=image%2Fpng&exp=9999999999&sig=x`, { method: "PUT", headers: { ...auth, "Content-Type": "image/png" }, body: Buffer.from([1, 2, 3]) });
const get = await fetch(`${base}/__dev/storage/${key}?exp=9999999999&sig=x`, { headers: auth });
process.stdout.write(`${JSON.stringify({ enabled: isDevStorageReceiverEnabled(), put: put.status, get: get.status })}\n`);
server.close();
process.exit(0);
