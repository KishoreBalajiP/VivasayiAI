// Which supporting documents a claim needs, by the claimant's relationship to the land.
//
// A claimant is not always the recorded landholder: tenants, joint owners, heirs and authorised
// cultivators have legitimate claims and a DIFFERENT name on the land record. Asking every claimant
// for the same document would reject them, so each relationship has its own evidence requirement.
//
// PROVISIONAL POLICY. The groups below are engineering's reading of what each relationship needs.
// They have not been reviewed by the product owner or by anyone with legal or insurer authority and
// must be before this drives real decisions. A group is satisfied when ANY of its categories is
// attached; a relationship is satisfied when EVERY group is. Categories come from
// OWNERSHIP_DOCUMENT_CATEGORIES (utils/ownershipEvidence.js).

export const CLAIMANT_RELATIONSHIPS = Object.freeze(["owner", "joint_owner", "tenant", "authorised_cultivator", "heir"]);

export const REQUIRED_CATEGORY_GROUPS = Object.freeze({
  owner: [["land_record", "ownership_deed"]],
  joint_owner: [["land_record", "ownership_deed"]],
  // The lease is the claimant's right; a land record or tax receipt shows which land it concerns.
  tenant: [["lease_agreement"], ["land_record", "ownership_deed", "tax_receipt"]],
  authorised_cultivator: [["authorization_letter"]],
  heir: [["land_record", "ownership_deed"], ["identity_proof", "other"]],
});

// The name on the land record is EXPECTED to differ from the claimant's for these relationships, so a
// name mismatch is not a discrepancy (the rest of the checks still apply).
const HOLDER_MAY_DIFFER = new Set(["joint_owner", "tenant", "authorised_cultivator", "heir"]);
export const holderNameMayDiffer = (relationship) => HOLDER_MAY_DIFFER.has(relationship);

// Groups for which no attached category qualifies. [] means the requirement is met (or there is none).
export const missingCategoryGroups = ({ relationship, categories = [] }) => {
  const groups = REQUIRED_CATEGORY_GROUPS[relationship];
  if (!groups) return [];
  const have = new Set(categories.filter(Boolean));
  return groups.filter((group) => !group.some((category) => have.has(category)));
};

export default { CLAIMANT_RELATIONSHIPS, REQUIRED_CATEGORY_GROUPS, holderNameMayDiffer, missingCategoryGroups };
