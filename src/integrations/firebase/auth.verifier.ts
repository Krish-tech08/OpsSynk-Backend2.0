import { Errors } from "../../utils/errors.js";

export interface AuthUser { uid: string; email?: string }

/** Verifies a bearer token and returns the authenticated user. */
export interface AuthVerifier {
  mode: "firebase" | "dev" | "test";
  verify(token: string): Promise<AuthUser>;
}

/** Firebase ID token verification through the Admin SDK (signature, expiry, audience, revocation). */
export function createFirebaseVerifier(verifyIdToken: (t: string, checkRevoked: boolean) => Promise<{ uid: string; email?: string }>): AuthVerifier {
  return {
    mode: "firebase",
    async verify(token) {
      try {
        const decoded = await verifyIdToken(token, true);
        return { uid: decoded.uid, email: decoded.email };
      } catch {
        throw Errors.unauthenticated("The authentication token is invalid or expired.");
      }
    },
  };
}

/**
 * Local development only: accepts "dev:<uid>". loadEnv() refuses AUTH_MODE=dev in production.
 * Organization membership is still enforced, so a dev uid sees nothing unless it is a member.
 */
export function createDevVerifier(): AuthVerifier {
  return {
    mode: "dev",
    async verify(token) {
      const m = /^dev:([A-Za-z0-9_-]{1,64})$/.exec(token);
      if (!m) throw Errors.unauthenticated("Dev auth expects a token of the form dev:<uid>.");
      return { uid: m[1] };
    },
  };
}
