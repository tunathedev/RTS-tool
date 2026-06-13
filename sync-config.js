/* Global sync configuration.
 *
 * Leave SYNC_CONFIG = null to keep the app device-only (everything saved per
 * device, no sync). To turn on live sync across ALL devices, create a free
 * Firebase project, enable Realtime Database, and paste its config here.
 *
 * Steps (see README "Global sync"):
 *   1. https://console.firebase.google.com → Add project (free "Spark" plan)
 *   2. Build → Realtime Database → Create database → Start in test mode
 *   3. Project settings → General → "Your apps" → Web app → copy the config
 *   4. Paste it below (must include databaseURL) and commit this file.
 *
 * Example:
 * window.SYNC_CONFIG = {
 *   apiKey: "AIza…",
 *   authDomain: "your-app.firebaseapp.com",
 *   databaseURL: "https://your-app-default-rtdb.firebaseio.com",
 *   projectId: "your-app",
 *   appId: "1:…:web:…"
 * };
 */
window.SYNC_CONFIG = null;
