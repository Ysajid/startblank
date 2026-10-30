import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// The writer's own profile: a name, a short bio, and the styles they write
// in (a few words each on how they sound for a kind of piece). Kept in the
// account's user metadata, so it follows them to every device without a
// table of its own.

export interface WritingStyle {
  name: string;
  description: string;
}

export interface Profile {
  displayName: string;
  bio: string;
  styles: WritingStyle[];
}

const MAX_STYLES = 12;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function readProfile(user: User): Profile {
  const meta = user.user_metadata ?? {};
  const styles = Array.isArray(meta.writing_styles) ? meta.writing_styles : [];
  return {
    displayName: text(meta.display_name, 80),
    bio: text(meta.bio, 2000),
    styles: styles
      .filter((s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({ name: text(s.name, 60), description: text(s.description, 600) }))
      .slice(0, MAX_STYLES),
  };
}

export async function saveProfile(profile: Profile): Promise<void> {
  const styles = profile.styles
    .map((s) => ({ name: s.name.trim(), description: s.description.trim() }))
    .filter((s) => s.name || s.description)
    .slice(0, MAX_STYLES);
  const { error } = await supabase.auth.updateUser({
    data: {
      display_name: profile.displayName.trim(),
      bio: profile.bio.trim(),
      writing_styles: styles,
    },
  });
  if (error) throw new Error(error.message);
}

export { MAX_STYLES };
