// Tamil Nadu district reference data (E2-S2, ADR-014, 07_Database_Design §5/§8).
// Server-side single source of truth for the `districts` collection. This mirrors the
// authoritative frontend config (`tn-farming-assistant-frontend/src/config/tamilnaduDistricts.ts`,
// 37 entries) so the backend owns the reference data and the frontend copy stays display-only.
//
// NOTE: The backlog and docs reference "38 TN districts"; the frontend config contains 37
// (Mayiladuthurai, the 38th, is not yet present). We seed exactly what the config provides —
// no phantom 38th row — and this is surfaced in the T-202 review.
//
// Soil/crops (regionType !== these): E2-S2's config source only carries name/lat/lon/`type`.
// Soil/crops are intentionally NOT fabricated here; the schema reserves the fields and D-19
// backfills them later from the TNAU district soil table + published crop lists.
const DISTRICT_REFERENCE = Object.freeze([
  { name: "Chennai", lat: 13.0827, lon: 80.2707, regionType: "Coastal" },
  { name: "Kancheepuram", lat: 12.8352, lon: 79.7, regionType: "Coastal" },
  { name: "Tiruvallur", lat: 13.1447, lon: 79.9081, regionType: "Coastal" },
  { name: "Coimbatore", lat: 11.0168, lon: 76.9558, regionType: "Western Ghats" },
  { name: "Erode", lat: 11.341, lon: 77.7172, regionType: "Western" },
  { name: "Madurai", lat: 9.9252, lon: 78.1198, regionType: "Southern" },
  { name: "Trichy", lat: 10.7905, lon: 78.7047, regionType: "Central" },
  { name: "Salem", lat: 11.6643, lon: 78.146, regionType: "Central" },
  { name: "Tirunelveli", lat: 8.7139, lon: 77.7567, regionType: "Southern" },
  { name: "Thanjavur", lat: 10.7869, lon: 79.1378, regionType: "Delta" },
  { name: "Vellore", lat: 12.9165, lon: 79.1325, regionType: "Northern" },
  { name: "Dharmapuri", lat: 12.121, lon: 78.1582, regionType: "Western" },
  { name: "Cuddalore", lat: 11.7045, lon: 79.535, regionType: "Coastal" },
  { name: "Nagapattinam", lat: 10.7667, lon: 79.8333, regionType: "Coastal" },
  { name: "Kanyakumari", lat: 8.0883, lon: 77.5385, regionType: "Coastal" },
  { name: "Karur", lat: 10.9603, lon: 78.0767, regionType: "Central" },
  { name: "Pudukkottai", lat: 10.379, lon: 78.82, regionType: "Southern" },
  { name: "Ramanathapuram", lat: 9.3789, lon: 78.8381, regionType: "Coastal" },
  { name: "Sivaganga", lat: 9.8432, lon: 78.4809, regionType: "Southern" },
  { name: "Theni", lat: 10.0104, lon: 77.4768, regionType: "Western" },
  { name: "Tiruppur", lat: 11.1085, lon: 77.3411, regionType: "Western" },
  { name: "Tiruvannamalai", lat: 12.2253, lon: 79.0747, regionType: "Northern" },
  { name: "Villupuram", lat: 11.9398, lon: 79.492, regionType: "Northern" },
  { name: "Virudhunagar", lat: 9.569, lon: 77.953, regionType: "Southern" },
  { name: "Krishnagiri", lat: 12.5186, lon: 78.2137, regionType: "Western" },
  { name: "Ariyalur", lat: 11.1377, lon: 79.0753, regionType: "Central" },
  { name: "Nilgiris", lat: 11.4911, lon: 76.7336, regionType: "Hills" },
  { name: "Perambalur", lat: 11.2226, lon: 78.8829, regionType: "Central" },
  { name: "Dindigul", lat: 10.3621, lon: 77.9695, regionType: "Southern" },
  { name: "Namakkal", lat: 11.2212, lon: 78.1652, regionType: "Central" },
  { name: "Thoothukudi", lat: 8.7642, lon: 78.1348, regionType: "Coastal" },
  { name: "Kallakurichi", lat: 11.74, lon: 78.96, regionType: "Northern" },
  { name: "Ranipet", lat: 12.9276, lon: 79.5, regionType: "Northern" },
  { name: "Tenkasi", lat: 8.96, lon: 77.3, regionType: "Southern" },
  { name: "Tirupathur", lat: 12.4975, lon: 78.5592, regionType: "Northern" },
  { name: "Chengalpattu", lat: 12.681, lon: 79.9768, regionType: "Coastal" },
  { name: "Mayiladuthurai", lat: 11.1035, lon: 79.655, regionType: "Delta" }
]);

export const districtReference = DISTRICT_REFERENCE;

export default districtReference;
