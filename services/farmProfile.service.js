import FarmProfile from "../models/FarmProfile.js";

// Farm profile data access (E2-S4). A profile is 1:1 with a user (keyed by userEmail), so
// create/update is a single upsert. The Context Engine slice (E2-S3) calls `getByUser` to
// auto-load the profile for zero-question continuity (D-14).

const normalizeEmail = (email) => (email || "").trim().toLowerCase();

const upsert = async ({ userEmail, district, crops, acres, language }) => {
  const key = normalizeEmail(userEmail);
  const set = { district, crops, acres };
  if (language) set.language = language;
  return FarmProfile.findOneAndUpdate(
    { userEmail: key },
    { $set: set },
    { upsert: true, new: true, runValidators: true }
  ).exec();
};

const getByUser = async (userEmail) => {
  if (!userEmail) return null;
  return FarmProfile.findOne({ userEmail: normalizeEmail(userEmail) }).lean().exec();
};

const remove = async (userEmail) => {
  const key = normalizeEmail(userEmail);
  const profile = await FarmProfile.findOne({ userEmail: key });
  if (!profile) return null;
  await profile.deleteOne();
  return profile;
};

export { upsert, getByUser, remove };
