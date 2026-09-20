import FarmProfile from "../models/FarmProfile.js";

// Farm profile data access (E2-S4). A profile is 1:1 with a user. E1-S5 (D-35): the profile is
// scoped by the authenticated user's cognitoSub (from the verified token); userEmail is retained
// as a display/legacy dual-key and set server-side, never from the client.
// The Context Engine slice (E2-S3) calls `getByUser` to auto-load the profile for zero-question
// continuity (D-14).

const upsert = async ({ cognitoSub, email, district, crops, acres, language }) => {
  const set = { district, crops, acres, userEmail: email ?? null };
  if (language) set.language = language;
  return FarmProfile.findOneAndUpdate(
    { cognitoSub },
    { $set: set, $setOnInsert: { cognitoSub } },
    { upsert: true, new: true, runValidators: true }
  ).exec();
};

// Owned lookup by cognitoSub (from req.user); returns null if the caller has no profile.
// Phase 1 (F-49/P10): legacy profile documents may not have a stored parcels array. Normalize
// the read model to parcels: [] without writing fabricated geometry back to the database.
const getByUser = async (cognitoSub) => {
  if (!cognitoSub) return null;
  const profile = await FarmProfile.findOne({ cognitoSub }).lean().exec();
  if (!profile) return null;
  return { ...profile, parcels: Array.isArray(profile.parcels) ? profile.parcels : [] };
};

const remove = async (cognitoSub) => {
  if (!cognitoSub) return null;
  const profile = await FarmProfile.findOneAndDelete({ cognitoSub });
  return profile;
};

export { upsert, getByUser, remove };
