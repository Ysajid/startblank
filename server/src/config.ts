// All configuration comes from the environment (see deploy/vault.env.example).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  // One folder per account lives under here: <root>/<user id>/<note path>.
  vaultRoot: required("VAULT_ROOT"),
  supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
  // Used only to write the search index (public.note_index): the project's
  // secret key (sb_secret_…) or legacy service_role key.
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  // Only for projects still on the legacy shared JWT secret; projects using
  // JWT signing keys are verified against their published JWKS instead.
  jwtSecret: process.env.SUPABASE_JWT_SECRET || null,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 5 * 1024 * 1024),
  // Watch the vault folder so files written by anything else on this
  // machine (agents, scripts, rsync) get indexed too.
  watch: process.env.WATCH !== "0",
};
