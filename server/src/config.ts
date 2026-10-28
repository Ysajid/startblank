// All configuration comes from the environment (see deploy/vault.env.example).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  // The server connects as startblank_app (row-level security applies);
  // migrations run separately as the database owner.
  databaseUrl: required("DATABASE_URL"),
  // Sign-in stays with Supabase: tokens are verified against this project.
  supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
  // Only for projects still on the legacy shared JWT secret; projects using
  // JWT signing keys are verified against their published JWKS instead.
  jwtSecret: process.env.SUPABASE_JWT_SECRET || null,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  maxNoteBytes: Number(process.env.MAX_NOTE_BYTES ?? 5 * 1024 * 1024),
};
