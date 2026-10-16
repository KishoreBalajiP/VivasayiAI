import { COMPONENTS } from "../config/verificationPolicy.js";
import { evaluateAiCheck } from "./claimVerificationEngine.service.js";
import { missingCategoryGroups } from "../config/claimantEvidence.js";

// ADR-020 — component resolver. PURE: no database, no network, no clock except the injected `now`.
// It turns the evidence the system holds for a claim into one outcome per verification component,
// so the engine and the farmer/reviewer can each see WHICH part of a claim is unresolved and why.
//
// Outcome vocabulary: verified | failed | unverified | unavailable | inconclusive | pending |
// requires_review. The rules that keep this honest:
//   - a provider failure or a disabled provider is `unavailable`, never `failed`;
//   - a missing piece of evidence is `unverified`, never `failed`;
//   - `failed` needs a POSITIVE finding that contradicts the claim;
//   - AI-derived evidence (photographs, document reading) never makes a component authoritative,
//     and AI alone can never verify claimant rights;
//   - satellite and weather are supporting evidence: they are never `failed`.

const KEY = {
  document: "owndoc_",
  officialRecord: "officialland_",
  reviewCase: ["rv_", "review_"],
};

const time = (row) => new Date(row.createdAt || row.updatedAt || 0).getTime();
const newestFirst = (rows) => [...rows].sort((a, b) => time(b) - time(a));
const keyOf = (row) => String(row.idempotencyKey || "");

const isReviewCase = (row) =>
  (row.metadata && (row.metadata.kind === "review_case" || row.metadata.reviewRequired === true)) ||
  KEY.reviewCase.some((prefix) => keyOf(row).startsWith(prefix));
const isDocument = (row) => row.source === "OWNERSHIP" && keyOf(row).startsWith(KEY.document);
const isOfficialRecord = (row) => row.source === "OWNERSHIP" && keyOf(row).startsWith(KEY.officialRecord);

const ref = (row) => ({
  id: String(row._id),
  source: row.source,
  status: row.status,
  updatedAt: row.updatedAt || row.createdAt || null,
  evidenceVersion: row.evidenceVersion || null,
});

const entry = (outcome, extra = {}) => ({
  outcome,
  required: false,
  authoritative: false,
  actionableBy: outcome === "verified" ? null : "system",
  reasonCodes: [],
  evidenceRefs: [],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// Per-component resolvers
// ---------------------------------------------------------------------------------------------

const resolveParcelIdentity = ({ claim }) => {
  const registered = Boolean(claim && claim.parcelId && claim.parcelSnapshot && claim.parcelSnapshot.parcelId);
  if (!registered) return entry("unverified", { actionableBy: "farmer", reasonCodes: ["no_registered_parcel"] });
  // The parcel is the claimant's own registered parcel (ownership-scoped lookup). That is NOT the
  // same as the parcel being verified against an official record.
  return entry("verified", { reasonCodes: ["registered_parcel_owned_by_claimant", "not_verified_against_official_record"] });
};

const resolveGeometry = ({ spatial }) => {
  const inside = spatial ? spatial.insideParcel : null;
  if (inside === true) {
    return entry("verified", { reasonCodes: ["inside_registered_parcel", "no_authoritative_boundary"] });
  }
  if (inside === false) return entry("failed", { actionableBy: "farmer", reasonCodes: ["outside_registered_parcel"] });
  return entry("unverified", { actionableBy: "system", reasonCodes: ["spatial_check_not_evaluated"] });
};

const resolvePhotos = ({ claim, assessment, evidenceCount, policy }) => {
  const ai = evaluateAiCheck({ claim: claim || {}, assessment, evidenceCount: Number(evidenceCount) || 0 });
  if (ai.passed) return entry("verified", { reasonCodes: ["ai_observation_supports_claim", "ai_is_not_authoritative"] });
  switch (ai.code) {
    case "no_evidence":
      return entry("unverified", { actionableBy: "farmer", reasonCodes: ["no_photographs"] });
    case "assessment_unavailable": {
      const failed = assessment && assessment.verification && assessment.verification.status === "failed";
      return entry(failed ? "unavailable" : "pending", { reasonCodes: [failed ? "ai_assessment_failed" : "ai_assessment_pending"] });
    }
    case "no_damage_confident":
      return policy && policy.aiNoDamage === "review"
        ? entry("requires_review", { actionableBy: "reviewer", reasonCodes: ["ai_no_damage_needs_review"] })
        : entry("failed", { actionableBy: "farmer", reasonCodes: ["ai_no_damage_detected"] });
    case "poor_quality":
      return entry("unverified", { actionableBy: "farmer", reasonCodes: ["photo_quality_too_poor"] });
    default:
      return entry("inconclusive", { actionableBy: "farmer", reasonCodes: [`ai_${ai.code}`] });
  }
};

const resolveOverlap = ({ spatial, crossOverlap }) => {
  const reasonCodes = [];
  let outcome;
  const status = spatial ? spatial.overlapStatus : "unchecked";
  if (status === "overlaps_verified") {
    outcome = spatial.fullyCovered ? "failed" : "verified";
    reasonCodes.push(spatial.fullyCovered ? "duplicates_verified_claim" : "partial_overlap_remainder_approved");
  } else if (status === "overlaps_in_flight") {
    outcome = "pending";
    reasonCodes.push("overlaps_claim_in_progress");
  } else if (status === "none") {
    outcome = "verified";
    reasonCodes.push("no_overlap_with_own_claims");
  } else {
    outcome = "unverified";
    reasonCodes.push("overlap_not_checked");
  }
  // Another farmer's claim over the same land is a signal for a person, never an automatic verdict:
  // shared boundaries, joint holdings and cadastral error are all legitimate causes.
  if (crossOverlap && crossOverlap.flagged) {
    reasonCodes.push("overlaps_other_farmers_claim");
    return entry("requires_review", { actionableBy: "reviewer", reasonCodes });
  }
  return entry(outcome, { actionableBy: outcome === "verified" ? null : outcome === "failed" ? "farmer" : "system", reasonCodes });
};

const resolveCrop = ({ claim, assessment }) => {
  const crops = [
    ...new Set(
      ((assessment && assessment.aiImageAssessments) || [])
        .map((image) => image.observation && image.observation.cropDetected)
        .filter(Boolean)
    ),
  ];
  const parcelCrop = claim && claim.parcelSnapshot && claim.parcelSnapshot.crop;
  if (!parcelCrop || crops.length === 0) return entry("unverified", { reasonCodes: ["crop_not_comparable"] });
  // No authoritative crop taxonomy exists ("Paddy" vs "rice"), so a difference is informational.
  return crops.length === 1 && crops[0].toLowerCase() === String(parcelCrop).toLowerCase()
    ? entry("verified", { reasonCodes: ["ai_crop_matches_parcel_crop", "ai_is_not_authoritative"] })
    : entry("inconclusive", { reasonCodes: ["crop_naming_differs_informational_only"] });
};

const resolveLandDocuments = ({ documents }) => {
  if (documents.length === 0) return entry("unverified", { actionableBy: "farmer", reasonCodes: ["no_land_document"] });
  const examined = documents
    .map((row) => (row.result && row.result.aiLandDocumentExamination) || null)
    .filter(Boolean);
  if (examined.length === 0) return entry("pending", { reasonCodes: ["document_not_yet_examined"], evidenceRefs: documents.map(ref) });
  const flagged = examined.some((exam) => exam.reviewRequired);
  // An AI reading of a document is consistency evidence only. It can ask for review, but it can
  // never make the document authentic.
  return flagged
    ? entry("requires_review", { actionableBy: "reviewer", reasonCodes: ["document_examination_flagged"], evidenceRefs: documents.map(ref) })
    : entry("inconclusive", { reasonCodes: ["document_consistent_not_authentic_proof"], evidenceRefs: documents.map(ref) });
};

const resolveClaimantRights = ({ claim, documents, officialRecords }) => {
  const refs = [...documents, ...officialRecords].map(ref);
  const by = (status) => documents.filter((row) => row.status === status);

  // The claimant's declared relationship to the land decides WHICH documents are expected (a tenant
  // needs a lease, not the landowner's deed). Until they are attached the farmer is asked for that
  // specific category, whatever any single document's review says. Claims without a declared
  // relationship keep the historical behaviour below.
  const relationship = claim && claim.claimantRelationship;
  if (relationship) {
    const categories = documents.map((row) => row.metadata && row.metadata.documentCategory);
    const missing = missingCategoryGroups({ relationship, categories });
    if (missing.length > 0) {
      return entry("unverified", {
        actionableBy: "farmer",
        reasonCodes: [...missing.map((group) => `missing_document_category:${group.join("|")}`), `relationship_${relationship}`],
        evidenceRefs: refs,
      });
    }
  }

  if (by("VERIFIED").length > 0) {
    return entry("verified", { authoritative: true, reasonCodes: ["document_verified_authoritatively"], evidenceRefs: refs });
  }
  if (by("AVAILABLE").length > 0) {
    // An administrator reviewed the document and accepted it. Manual, so not authoritative.
    return entry("verified", { reasonCodes: ["document_accepted_by_manual_review", "not_authoritative"], evidenceRefs: refs });
  }
  if (by("INCONSISTENT").length > 0) {
    return entry("failed", { actionableBy: "farmer", reasonCodes: ["document_reviewed_inconsistent"], evidenceRefs: refs });
  }
  if (by("PENDING").length > 0) {
    return entry("pending", { actionableBy: "reviewer", reasonCodes: ["document_awaiting_manual_review"], evidenceRefs: refs });
  }
  if (documents.length > 0) {
    // INSUFFICIENT / UNAVAILABLE reviews: the farmer must supply a better document.
    return entry("unverified", { actionableBy: "farmer", reasonCodes: ["document_reviewed_insufficient"], evidenceRefs: refs });
  }
  const official = officialRecords[0];
  if (official) {
    const status = official.result && official.result.officialLandRecord && official.result.officialLandRecord.status;
    if (status === "mismatch" || status === "not_found") {
      return entry("requires_review", { actionableBy: "reviewer", reasonCodes: [`official_record_${status}`], evidenceRefs: refs });
    }
    if (status === "matched") {
      return entry("inconclusive", { reasonCodes: ["official_record_matched_not_live_validated"], evidenceRefs: refs });
    }
    return entry("unavailable", { reasonCodes: ["official_record_unavailable"], evidenceRefs: refs });
  }
  return entry("unverified", { actionableBy: "farmer", reasonCodes: ["no_ownership_evidence"] });
};

const resolveSatellite = ({ satelliteRows }) => {
  const row = satelliteRows[0];
  if (!row) return entry("unverified", { reasonCodes: ["satellite_not_run"] });
  const evidenceRefs = [ref(row)];
  switch (row.status) {
    case "NOT_CHECKED":
    case "UNAVAILABLE":
      return entry("unavailable", { reasonCodes: ["satellite_unavailable_or_disabled"], evidenceRefs });
    case "AVAILABLE": {
      const outcome = row.result && row.result.analysisOutcome;
      return outcome === "SUPPORTS_LOSS"
        ? entry("verified", { reasonCodes: ["ndvi_change_consistent_with_loss", "not_proof_of_cause"], evidenceRefs })
        : entry("inconclusive", { reasonCodes: [outcome ? `satellite_${String(outcome).toLowerCase()}` : "analysis_not_interpreted"], evidenceRefs });
    }
    default:
      // PENDING (imagery found, nothing analysed) and INSUFFICIENT (cloud / coverage).
      return entry("inconclusive", { reasonCodes: ["satellite_insufficient_for_conclusion"], evidenceRefs });
  }
};

const resolveWeather = ({ weatherRows, assessment }) => {
  const row = weatherRows[0];
  if (row) {
    const evidenceRefs = [ref(row)];
    if (row.status === "UNAVAILABLE" || row.status === "NOT_CHECKED") {
      return entry("unavailable", { reasonCodes: ["weather_unavailable"], evidenceRefs });
    }
    return row.status === "AVAILABLE"
      ? entry("verified", { reasonCodes: ["weather_supporting_only"], evidenceRefs })
      : entry("inconclusive", { reasonCodes: ["weather_insufficient"], evidenceRefs });
  }
  return assessment && assessment.weatherCorrelation
    ? entry("inconclusive", { reasonCodes: ["weather_correlation_recorded_supporting_only"] })
    : entry("unverified", { reasonCodes: ["weather_not_retrieved"] });
};

const resolveManualReview = ({ reviewRows }) => {
  const open = reviewRows.filter((row) => row.status === "PENDING");
  if (open.length > 0) {
    return entry("requires_review", { actionableBy: "reviewer", reasonCodes: ["review_case_open"], evidenceRefs: open.map(ref) });
  }
  return reviewRows.length > 0
    ? entry("verified", { reasonCodes: ["review_cases_resolved"], evidenceRefs: reviewRows.map(ref) })
    : entry("unverified", { reasonCodes: ["no_review_case"] });
};

// ---------------------------------------------------------------------------------------------

// Group the claim's evidence rows. Works on rows written before the `component` field existed by
// deriving the group from the idempotency-key prefix and source.
export const groupEvidence = (rows = []) => {
  const list = newestFirst(rows);
  return {
    documents: list.filter((row) => isDocument(row) && !isReviewCase(row)),
    officialRecords: list.filter((row) => isOfficialRecord(row)),
    reviewRows: list.filter((row) => isReviewCase(row)),
    satelliteRows: list.filter((row) => row.source === "SATELLITE"),
    weatherRows: list.filter((row) => row.source === "WEATHER"),
  };
};

export const resolveComponents = ({
  claim = null,
  assessment = null,
  spatial = null,
  crossOverlap = null,
  evidenceRows = [],
  evidenceCount = 0,
  policy = null,
} = {}) => {
  const groups = groupEvidence(evidenceRows);
  const context = { claim, assessment, spatial, crossOverlap, evidenceCount, policy, ...groups };

  const resolved = {
    parcel_identity: resolveParcelIdentity(context),
    claimant_rights: resolveClaimantRights(context),
    land_documents: resolveLandDocuments(context),
    geometry: resolveGeometry(context),
    crop: resolveCrop(context),
    satellite: resolveSatellite(context),
    photos: resolvePhotos(context),
    weather: resolveWeather(context),
    overlap: resolveOverlap(context),
    manual_review: resolveManualReview(context),
  };

  // Apply the policy's required flags. "when_open": required only while a review case is open.
  for (const name of COMPONENTS) {
    const setting = policy && policy.components && policy.components[name] ? policy.components[name].required : false;
    resolved[name].required =
      setting === "when_open" ? resolved[name].outcome === "requires_review" : Boolean(setting);
  }
  return resolved;
};

export default { resolveComponents, groupEvidence };
