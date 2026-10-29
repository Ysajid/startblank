// Search and backlinks run in Supabase Postgres, in the same database as the
// notes — so results are never out of date, and the app never has to
// download a note it isn't showing.
export { fetchBacklinks, searchNotes, type SearchHit } from "./vaultStorage";
