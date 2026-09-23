import crypto from "crypto";
import FarmProfile from "../models/FarmProfile.js";
import { validateParcelGeometry } from "./parcelGeometry.service.js";

// Farm parcel data access + authority (F-49, Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4/P10).
//
// Ownership is ALWAYS scoped by the authenticated user's cognitoSub (from req.user, E1-S5/D-35);
// the client never supplies an owner identity. A farmer can only ever read/update/delete their
// own parcels; foreign/unowned access is a 404 (matches the IDOR pattern of ADR-018).
// `calculatedAreaAcres` is ALWAYS recomputed server-side from geometry here — never trusted
// from the request body. Parcel creation is additive: legacy profiles simply gain a parcel.

const MUTATION_LIMITS = { new: true, runValidators: true };

// Server-generated opaque parcel identifier (par_<uuid>); client may never choose it.
const generateParcelId = () => `par_${crypto.randomUUID()}`;

const toParcelPojo = (parcel) => {
  if (!parcel) return null;
  return {
    parcelId: parcel.parcelId,
    name: parcel.name,
    crop: parcel.crop,
    geometry: parcel.geometry,
    calculatedAreaAcres: parcel.calculatedAreaAcres,
    createdAt: parcel.createdAt,
    updatedAt: parcel.updatedAt,
  };
};

// Load a profile owned by cognitoSub. Returns null when the caller has no profile.
const getOwnedProfile = async (cognitoSub) => {
  if (!cognitoSub) return null;
  return FarmProfile.findOne({ cognitoSub }).exec();
};

// Find a parcel owned by cognitoSub. Returns { profile, parcelIndex, parcel } or null when the
// profile does not exist, and null parcel when the parcel does not belong to the caller.
const findOwnedParcel = async (cognitoSub, parcelId) => {
  const profile = await getOwnedProfile(cognitoSub);
  if (!profile) return null;
  const parcelIndex = profile.parcels.findIndex((p) => p.parcelId === parcelId);
  if (parcelIndex === -1) return { profile, parcelIndex: -1, parcel: null };
  return { profile, parcelIndex, parcel: profile.parcels[parcelIndex] };
};

const listForUser = async (cognitoSub) => {
  const profile = await getOwnedProfile(cognitoSub);
  if (!profile) return [];
  return (profile.parcels || []).map(toParcelPojo);
};

// Create a parcel for the caller's profile. Requires an existing FarmProfile (the farmer must
// have onboarded — crop loss claims are out of scope this phase, and parcels are never
// auto-created, P10). Returns { parcel, profile } or null if there is no owned profile.
const createForUser = async (cognitoSub, { name, crop, geometry }) => {
  const profile = await getOwnedProfile(cognitoSub);
  if (!profile) return null;

  const validation = validateParcelGeometry(geometry);
  if (!validation.ok) return { error: true, message: validation.reason };

  // Authority: re-validate + compute area server-side only (P4). Any client-supplied area is
  // ignored because the parcel object is constructed here, never from the request body.
  const parcel = {
    parcelId: generateParcelId(),
    name,
    crop,
    geometry,
    calculatedAreaAcres: validation.acres,
  };

  profile.parcels.push(parcel);
  await profile.save();
  const savedParcel = profile.parcels.find((p) => p.parcelId === parcel.parcelId);
  return { parcel: toParcelPojo(savedParcel), profile };
};

// GET a single owned parcel. Null when the caller has no profile OR the parcel is not theirs
// (both surface as 404 in the controller, no existence disclosure).
const getForUser = async (cognitoSub, parcelId) => {
  const found = await findOwnedParcel(cognitoSub, parcelId);
  if (!found) return null;
  return toParcelPojo(found.parcel);
};

// Update allowed fields (name, crop, geometry) on an owned parcel. If geometry changes, the
// authoritative area is recomputed. Returns { parcel } | { error } | null (no profile) |
// { notFound: true } (profile exists but the parcel is not the caller's).
const updateForUser = async (cognitoSub, parcelId, { name, crop, geometry } = {}) => {
  const found = await findOwnedParcel(cognitoSub, parcelId);
  if (!found) return null;
  if (!found.parcel) return { notFound: true };

  const { profile, parcelIndex, parcel } = found;

  if (geometry !== undefined) {
    const validation = validateParcelGeometry(geometry);
    if (!validation.ok) return { error: true, message: validation.reason };
    parcel.geometry = geometry;
    parcel.calculatedAreaAcres = validation.acres;
  }
  if (name !== undefined) parcel.name = name;
  if (crop !== undefined) parcel.crop = crop;

  // Hide the patch body until async mutations are edge-safe on the subdoc.
  await profile.save();
  return { parcel: toParcelPojo(profile.parcels[parcelIndex]) };
};

// DELETE an owned parcel only. Never deletes the profile or sibling parcels.
// Returns true | null (no profile) | { notFound: true } (parcel not the caller's).
const removeForUser = async (cognitoSub, parcelId) => {
  const found = await findOwnedParcel(cognitoSub, parcelId);
  if (!found) return null;
  if (!found.parcel) return { notFound: true };

  const { profile, parcelIndex } = found;
  profile.parcels.splice(parcelIndex, 1);
  await profile.save();
  return true;
};

// Recalculate authoritative area from stored geometry (API contract: PATCH handles it on
// geometry change; POST /area is exposed per finalized 08_API_Documentation item 10).
const recalculateAreaForUser = async (cognitoSub, parcelId) => {
  const found = await findOwnedParcel(cognitoSub, parcelId);
  if (!found) return null;
  if (!found.parcel) return { notFound: true };

  const { profile, parcelIndex, parcel } = found;
  const validation = validateParcelGeometry(parcel.geometry);
  if (!validation.ok) return { error: true, message: validation.reason };
  parcel.calculatedAreaAcres = validation.acres;
  await profile.save();
  return { parcel: toParcelPojo(profile.parcels[parcelIndex]) };
};

export { listForUser, createForUser, getForUser, updateForUser, removeForUser, recalculateAreaForUser };