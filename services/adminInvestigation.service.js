// Phase 10 (E9-S10) — Fraud investigation view (pure, unit-testable in isolation).
//
// OBSERVATION ONLY. This module never bans, blocks, or mutates anything (15_Security §5 /
// E9-S10 contract): it surfaces deterministic anomaly signals from the ordinary claim →
// parcel → geometry data so an admin can review patterns. Every entry carries human-readable
// flags with a severity; nothing here is an accusation, and no automatic enforcement exists.
//
// Signals computed (all from claim rows; geometry handled purely via coordinate tolerance):
//   rapid_succession     — a farmer created >= N claims inside one short window
//   parcel_reuse         — the same parcel used across multiple claims
//   geometry_twin        — two claims (any farmer) draw essentially the same polygon
//   repeated_rejection   — a farmer accumulates >= N rejected/duplicate/out_of_limit decisions
//   ai_uncertain_cluster — a farmer accumulates >= N claims the AI marked uncertain
//   event_concentration  — a farmer files >= N claims of one event type inside a narrow window

const roundTolerance = (coord, digits = 4) => Math.round(coord * 10 ** digits) / 10 ** digits;

export const geometryFingerprint = (geometry, digits = 4) =>
  Array.isArray(geometry?.coordinates?.[0])
    ? JSON.stringify(
        geometry.coordinates[0]
          .map((position) => position.map((coord) => roundTolerance(coord, digits)))
          .sort((a, b) => a.join() < b.join() ? -1 : 1)
      )
    : null;

export const DEFAULT_INVESTIGATION_CONFIG = {
  rapidLikeCount: 3,
  rapidWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  repeatedRejectionCount: 2,
  aiUncertainCount: 2,
  eventConcentrationCount: 3,
  eventWindowMs: 30 * 24 * 60 * 60 * 1000,
  geometryTwinMeters: 11, // ~ 0.0001 deg lat/lon at scale; fingerprint already rounded
};

const groupByOwner = (rows) =>
  rows.reduce((acc, row) => {
    const key = row.ownerKey ?? row.cognitoSub ?? "unknown";
    (acc[key] = acc[key] || []).push(row);
    return acc;
  }, {});

const flag = (code, label, severity, meta = {}) => ({ code, label, severity, ...meta });

const timestampOf = (value) => {
  const t = value ? new Date(value).getTime() : null;
  return Number.isFinite(t) && t > 0 ? t : null;
};

export const buildInvestigationEntries = (rows, config = DEFAULT_INVESTIGATION_CONFIG) => {
  const cfg = { ...DEFAULT_INVESTIGATION_CONFIG, ...config };
  const sourceIds = new Set(rows.map((row) => String(row._id ?? row.id ?? "")));
  const entries = [];

  const byOwner = groupByOwner(rows);
  for (const [ownerKey, ownerRows] of Object.entries(byOwner)) {
    const flags = [];
    const meta = {
      ownerKey,
      farmerEmail: ownerRows[0]?.farmerEmail ?? null,
      claimCount: ownerRows.length,
    };

    // Rapid succession: N claims created within a short window (sig: same farmer batch-filing).
    if (ownerRows.length >= cfg.rapidLikeCount) {
      const created = ownerRows
        .map((row) => timestampOf(row.createdAt))
        .filter(Boolean)
        .sort((a, b) => a - b);
      for (let i = 0; i + cfg.rapidLikeCount - 1 < created.length; i += 1) {
        if (created[i + cfg.rapidLikeCount - 1] - created[i] <= cfg.rapidWindowMs) {
          flags.push(flag("rapid_succession", "Multiple claims submitted in a short window", "medium", { count: cfg.rapidLikeCount }));
          break;
        }
      }
    }

    // Repeated rejection: repeated negative/duplicate decisions for one farmer.
    const rejections = ownerRows.filter((row) =>
      ["rejected", "duplicate_area", "out_of_limit"].includes(row.state)
    ).length;
    if (rejections >= cfg.repeatedRejectionCount) {
      flags.push(flag("repeated_rejection", "Farmer has multiple rejected or duplicate claims", "high", { count: rejections }));
    }

    // AI uncertainty cluster.
    const aiUncertain = ownerRows.filter((row) => Boolean(row?.assessment?.aiAggregate?.uncertain)).length;
    if (aiUncertain >= cfg.aiUncertainCount) {
      flags.push(flag("ai_uncertain_cluster", "Multiple claims the AI could not confidently assess", "low", { count: aiUncertain }));
    }

    // Event concentration: N claims of the same event type inside a narrow window.
    const byEvent = ownerRows.reduce((acc, row) => {
      const key = row.eventType ?? "unknown";
      (acc[key] = acc[key] || []).push(row);
      return acc;
    }, {});
    for (const [event, eventRows] of Object.entries(byEvent)) {
      if (eventRows.length >= cfg.eventConcentrationCount) {
        const dates = eventRows.map((row) => timestampOf(row.createdAt)).filter(Boolean).sort((a, b) => a - b);
        for (let i = 0; i + cfg.eventConcentrationCount - 1 < dates.length; i += 1) {
          if (dates[i + cfg.eventConcentrationCount - 1] - dates[i] <= cfg.eventWindowMs) {
            flags.push(flag("event_concentration", `Concentrated ${event} claims`, "medium", { event, count: eventRows.length }));
            break;
          }
        }
      }
    }

    // Parcel reuse: same parcel across multiple claims (sig for overlapping double compensation).
    const parcelUses = ownerRows.reduce((acc, row) => {
      if (row.parcelId) acc[row.parcelId] = (acc[row.parcelId] || 0) + 1;
      return acc;
    }, {});
    const reused = Object.entries(parcelUses).filter(([, count]) => count > 1);
    if (reused.length > 0) {
      flags.push(flag("parcel_reuse", "Same parcel used for multiple claims", "medium", { parcels: reused.map(([p, c]) => ({ parcelId: p, count: c })) }));
    }

    meta.claimIds = ownerRows.map((row) => String(row._id ?? row.id ?? ""));
    entries.push({ id: `owner_${ownerKey}`, ...meta, flags });
  }

  // Cross-farmer geometry twins: same rounded polygon drawn by different owners.
  const byFingerprint = rows.reduce((acc, row) => {
    const fp = geometryFingerprint(row.claimedGeometry);
    if (!fp) return acc;
    (acc[fp] = acc[fp] || []).push(row);
    return acc;
  }, {});
  for (const [fingerprint, twinRows] of Object.entries(byFingerprint)) {
    if (twinRows.length < 2) continue;
    const owners = new Set(twinRows.map((row) => String(row._id ?? row.id ?? "")));
    entries.push({
      id: `geometry_twin_${fingerprint.slice(0, 8)}`,
      ownerKey: null,
      farmerEmail: null,
      claimCount: twinRows.length,
      claimIds: [...owners],
      flags: [
        flag("geometry_twin", "Multiple claims reference near-identical drawn polygons", "high", {
          twinCount: twinRows.length,
        }),
      ],
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  const severityOf = (entry) =>
    entry.flags.length ? Math.min(...entry.flags.map((f) => severityRank[f.severity] ?? 3)) : 3;
  entries.sort((a, b) => severityOf(a) - severityOf(b));

  return entries;
};

export const summarizeInvestigation = (entries) => {
  const bySeverity = { high: [], medium: [], low: [] };
  for (const entry of entries) {
    const sev = severityOfEntry(entry);
    bySeverity[sev] = [...(bySeverity[sev] ?? []), entry];
  }
  return {
    totalEntries: entries.length,
    high: bySeverity.high.length,
    medium: bySeverity.medium.length,
    low: bySeverity.low.length,
  };
};

const severityOfEntry = (entry) => {
  const severityRank = { high: 0, medium: 1, low: 2 };
  if (!entry.flags.length) return "low";
  const worst = Math.min(...entry.flags.map((f) => severityRank[f.severity] ?? 3));
  return worst === 0 ? "high" : worst === 1 ? "medium" : "low";
};

export default {
  geometryFingerprint,
  buildInvestigationEntries,
  summarizeInvestigation,
  DEFAULT_INVESTIGATION_CONFIG,
};