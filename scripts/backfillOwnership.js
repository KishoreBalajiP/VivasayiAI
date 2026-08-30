// E1-S5 migration (D-35 ownership scoping): backfill the `cognitoSub` ownership key onto
// legacy email-keyed `chatsessions` and `profiles` documents (07_Database_Design §8 migration note).
// Mapping source: the `users` collection (User.email -> User.cognitoSub), populated since E1-S3.
// Idempotent: only documents missing `cognitoSub` are updated; already-scoped rows are untouched.
// Run: `node scripts/backfillOwnership.js [--dry-run]`
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { validateEnv, SERVER_REQUIRED } from "../config/env.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import ChatSession from "../models/ChatSession.js";
import FarmProfile from "../models/FarmProfile.js";

validateEnv(SERVER_REQUIRED);

const normalize = (email) => (email || "").trim().toLowerCase();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");

const backfillOwnership = async (dryRun) => {
  await connectDB();

  // Build email -> cognitoSub map from users that already have a stable sub (E1-S3+).
  const users = await User.find({ email: { $exists: true, $ne: null }, cognitoSub: { $exists: true, $ne: null } })
    .lean()
    .exec();
  const emailToSub = new Map();
  for (const u of users) {
    const n = normalize(u.email);
    if (!isEmail(n) || !u.cognitoSub) continue;
    // Skip ambiguous mappings (same email -> multiple cognitoSub) to avoid mis-scoping.
    if (emailToSub.has(n) && emailToSub.get(n) !== u.cognitoSub) {
      emailToSub.delete(n);
      continue;
    }
    emailToSub.set(n, u.cognitoSub);
  }

  const apply = async (model) => {
    const docs = await model.find({ cognitoSub: { $exists: false } }).select("userEmail").lean().exec();
    const bulk = [];
    let unmatched = 0;
    for (const d of docs) {
      const sub = emailToSub.get(normalize(d.userEmail));
      if (!sub) {
        // no known user mapping -> leave for re-keying on the user's next login
        unmatched++;
        continue;
      }
      bulk.push({ updateOne: { filter: { _id: d._id }, update: { $set: { cognitoSub: sub } } } });
    }
    if (dryRun) {
      return { considered: docs.length, wouldUpdate: bulk.length, unmatched };
    }
    let updated = 0;
    if (bulk.length) {
      const res = await model.bulkWrite(bulk, { ordered: false });
      updated = res.modifiedCount;
    }
    return { considered: docs.length, updated, unmatched };
  };

  const chatResult = await apply(ChatSession);
  const profileResult = await apply(FarmProfile);

  logger.info(
    {
      dryRun: dryRun || false,
      userMappings: emailToSub.size,
      chatsessions: chatResult,
      profiles: profileResult,
      remainingEmailKeyed: {
        chatsessions: await ChatSession.countDocuments({ cognitoSub: { $exists: false } }),
        profiles: await FarmProfile.countDocuments({ cognitoSub: { $exists: false } }),
      },
    },
    "ownership.backfill_complete"
  );
};

const dryRun = process.argv.includes("--dry-run");

backfillOwnership(dryRun)
  .then(() => {
    logger.info(dryRun ? "ownership.backfill_dry_run_done" : "ownership.backfill_done");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "ownership.backfill_failed");
    process.exit(1);
  });
