import { initializeApp, getApps, applicationDefault, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Initializes Firebase Admin with Application Default Credentials: GOOGLE_APPLICATION_CREDENTIALS
 * locally, or the hosting platform's service identity in production. No key material is read here.
 */
export function initFirebase(projectId: string): App {
  return getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId });
}
export const firebaseAuth = (app: App) => getAuth(app);
export const firestore = (app: App) => {
  const db = getFirestore(app);
  try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* settings already applied */ }
  return db;
};
