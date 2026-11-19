// LOCAL TESTING ONLY. Prints a short-lived (ACCESS_TOKEN_TTL_MS, default 15 min) backend access token
// for a dedicated evaluation identity, signed with SESSION_JWT_SECRET from .env by the backend's own
// signAccessToken (utils/token.js). It is accepted only by a backend that has the same secret, i.e. your
// local server. It does not log in to Cognito and has no admin role.
// Run from the repository root: node evaluation/make_token.mjs
process.env.LOG_LEVEL ||= "silent";
const { signAccessToken } = await import("../utils/token.js");
process.stdout.write(signAccessToken({ cognitoSub: "eval-assistant-2026", email: null, name: "Assistant evaluation", role: null }));
