/* Global sync configuration.
 *
 * Live sync is ON — this app's Firebase Realtime Database. The catalog edits,
 * pull list, production plan, and case-pack sizes sync across all devices.
 * To go back to device-only, set window.SYNC_CONFIG = null.
 */
/* NOTE: this apiKey is a Firebase *Web* API key. It is public by design — Google
 * intends it to ship in client code and be committed to the repo. It only names
 * the project; it does NOT grant data access. Security comes from the database
 * rules (firebase.rules.json) and, optionally, App Check below. See SECURITY.md. */
window.SYNC_CONFIG = {
  apiKey: "AIzaSyDiPIHiu06bx2xAxVMOuwt_d0p2VEZvluM",
  authDomain: "rts-ready.firebaseapp.com",
  databaseURL: "https://rts-ready-default-rtdb.firebaseio.com",
  projectId: "rts-ready",
  appId: "1:388726629784:web:f7d5dcb9e2ca7e5d6df7ed",

  // --- Optional App Check (blocks scripts that aren't the real app) ---
  // Leave these unset and nothing changes. To enable, see SECURITY.md:
  //   appCheckKey: "6Lc...your-reCAPTCHA-v3-site-key...",   // from Firebase → App Check
  //   appCheckDebug: "your-debug-token",                    // ONLY for localhost testing
};

/* Optional usage analytics → private Google Sheet (no location, no IP, no in-app view).
 * Off until you paste your Apps Script web-app URL here. Setup: see ANALYTICS.md. */
window.ANALYTICS_URL = "https://script.google.com/macros/s/AKfycbzB5AvVrWQUO1nGg866d91FP5ArT3OrJOUGbu8IlPXIhkR6Td3gHAhD_Qz9WJqg2dmF/exec";
