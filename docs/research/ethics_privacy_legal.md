# Ethical, legal and privacy statement

This is a statement of how the project handles the issues the research raises, and of what remains open. It
is not legal advice and it has not been reviewed by a lawyer, an institutional review board or the data
owners.

## Consent and data access
- Farmers' profiles, parcels, photographs and documents are accessed only for the authenticated farmer who owns
  them (ownership is scoped by the verified identity; foreign resources return not-found). The assistant uses
  only the records of the person asking.
- Research use of real farmer data requires informed consent in a language the farmer reads, a stated purpose,
  and a way to withdraw. **None has been obtained.** No real farmer data was used in any result in this repository.

## Personal and land-record privacy
- Uploaded documents are stored privately and reached only through short-lived signed links scoped to one
  object and its owner.
- The land-document examination stores the extracted fields on the evidence row. Raw document text and
  identifiers are not written to logs (tested). Other farmers' claims are never exposed to a claimant: overlap
  with another farmer is recorded only in the admin audit trail.
- Weather lookups use a location rounded to about 1 km.
- Land records are legally sensitive. Official records must not be used for research without the authority's
  permission.

## Official land-record access
- No authorised Tamil Nadu land-record or cadastral API is available to this project. The adapter returns
  `unavailable` rather than any positive result without one. Public portals must not be scraped or accessed
  in ways their terms do not allow.

## Satellite imagery
- Copernicus Sentinel data are free and open under the Copernicus data policy, subject to its attribution
  terms. Access through the Copernicus Data Space Ecosystem requires an account and follows its quotas and
  conditions. Derived statistics, not rasters, are stored.

## Fairness, false rejection and human review
- Adverse outcomes are costly to farmers. By design: an AI reading alone never rejects a claim under the
  component policy (it holds for a person); provider failure is `unavailable`, not a negative finding; lack
  of evidence asks for more evidence rather than failing; overlap with another farmer goes to review.
- The system can still disadvantage some farmers: tenants and heirs need different documents (the required
  document policy is provisional and unreviewed), names are matched across Tamil and Latin scripts by
  heuristics, low-quality photographs lower confidence, and NDVI-based evidence is weaker for some crops and
  seasons. These effects have not been measured on real claims and need review before any real use.
- Every adverse or uncertain outcome must be reachable by a human reviewer; the admin review endpoints exist,
  but no reviewer workflow or staffing is part of this project.

## Reproducibility without exposing data
- Evaluation inputs in this repository are synthetic or author-written. Anything derived from real documents or
  claims would be shared only as aggregate metrics, with identifiers removed. Credentials are never committed
  (`.env.example` holds placeholder names only).

## Not claimed
Government endorsement or integration, regulatory approval, insurer acceptance, publication, peer review, or
research novelty. None has been established.
