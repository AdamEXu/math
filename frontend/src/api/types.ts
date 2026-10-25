export type Me = {
  id: string;
  email: string;
  handle: string | null;
  display_name: string;
  avatar_url: string | null;
  avatar_hue: number;
  avatar_initial: string;
  suggested_handle: string | null;
};

export type Profile = { handle: string; display_name: string };
export type ProfileErrors = Partial<Record<keyof Profile, string>>;
export type ProfileRejection = { error: "invalid"; errors: ProfileErrors; profile: Profile };

export type HandleCheck = { handle: string; available: boolean; error: string | null };

export type Role = "owner" | "editor" | "viewer";
export type MemberRole = Exclude<Role, "owner">;
export type LinkAccess = MemberRole | null;

export type PublicUser = {
  id: string;
  handle: string | null;
  display_name: string;
  avatar_url: string | null;
  avatar_hue: number;
  avatar_initial: string;
};

export type Graph = {
  id: string;
  title: string;
  updated_at: number;
  thumbnail_at: number | null;
  folder_id: string | null;
  role: Role;
  owner: PublicUser;
};

export type Member = PublicUser & { role: MemberRole };
export type Sharing = { role: Role; link_access: LinkAccess; owner: PublicUser; members: Member[] };

export type Folder = { id: string; name: string; icon: string; color: string };
export type FolderChanges = Omit<Folder, "id">;
export type FolderList = { folders: Folder[]; icons: Record<string, string> };

export type Config = { desmos_scripts: string[] };
