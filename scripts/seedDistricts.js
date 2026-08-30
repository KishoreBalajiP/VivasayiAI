// E2-S2 seed: populate the `districts` reference collection from the server-side
// district config (config/districts.js, mirrored from the frontend `tamilnaduDistricts.ts`).
// Idempotent: re-running upserts by `name` and leaves soil/crops as empty reserved fields.
// Run: `node scripts/seedDistricts.js`
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { validateEnv, SERVER_REQUIRED } from "../config/env.js";
import logger from "../utils/logger.js";
import District from "../models/District.js";
import districtReference from "../config/districts.js";

validateEnv(SERVER_REQUIRED);

const seedDistricts = async () => {
  await connectDB();

  const ops = districtReference.map(({ name, lat, lon, regionType }) => ({
    updateOne: {
      filter: { name },
      update: { $set: { name, lat, lon, regionType } },
      upsert: true,
    },
  }));

  const result = await District.bulkWrite(ops, { ordered: false });

  const total = await District.countDocuments();
  const sourceCount = districtReference.length;

  logger.info(
    {
      sourceDistrictCount: sourceCount,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedCount,
      totalInDb: total,
    },
    "districts.seed_complete"
  );

  if (total !== sourceCount) {
    logger.warn(
      { totalInDb: total, sourceDistrictCount: sourceCount },
      "districts.seed_count_mismatch"
    );
    throw new Error(
      `District count mismatch: expected ${sourceCount}, DB has ${total}. ` +
        "Duplicate names in the reference config would be overwritten."
    );
  }
};

seedDistricts()
  .then(() => {
    logger.info("districts.seed_done");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "districts.seed_failed");
    process.exit(1);
  });
