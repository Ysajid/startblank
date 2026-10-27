import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";

// Requests carry the user's Supabase access token. It is verified locally —
// against the project's published signing keys, or the legacy shared secret
// — so no request needs a round trip to Supabase.

const issuer = `${config.supabaseUrl}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const secret = config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthError extends Error {}

export async function userIdFromRequest(authorization: string | undefined): Promise<string> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new AuthError("missing token");

  let payload: JWTPayload;
  try {
    const { alg } = decodeProtectedHeader(token);
    const options = { issuer, audience: "authenticated" };
    if (alg === "HS256") {
      if (!secret) throw new AuthError("HS256 tokens need SUPABASE_JWT_SECRET");
      payload = (await jwtVerify(token, secret, options)).payload;
    } else {
      payload = (await jwtVerify(token, jwks, options)).payload;
    }
  } catch (e) {
    throw e instanceof AuthError ? e : new AuthError("invalid token");
  }

  // The user id names the folder on disk, so accept nothing but a UUID.
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) throw new AuthError("invalid subject");
  return payload.sub.toLowerCase();
}
