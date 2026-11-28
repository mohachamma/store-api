import { getSupabaseAdmin } from "./supabase.js";
import { ApiError } from "./errors.js";

export interface AdminUser {
  id: string;
  email: string;
  createdAt: string | null;
  lastSignInAt: string | null;
}

/** Who may open the dashboard. The accounts live in Supabase Auth (role in `app_metadata.role`); tests and the local stack use a fake. */
export interface AdminDirectory {
  list(): Promise<AdminUser[]>;
  /** Makes the person an admin: an invitation email for a new account, or a promotion of an existing one. */
  invite(email: string): Promise<AdminUser>;
  /** Back to a normal customer account (the account itself is never deleted). */
  demote(id: string): Promise<void>;
}

const toUser = (u: { id: string; email?: string; created_at?: string; last_sign_in_at?: string }): AdminUser => ({
  id: u.id,
  email: u.email ?? "",
  createdAt: u.created_at ?? null,
  lastSignInAt: u.last_sign_in_at ?? null,
});

export function supabaseAdmins(): AdminDirectory {
  const auth = () => getSupabaseAdmin().auth.admin;
  async function all() {
    const out: ReturnType<typeof toUser>[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await auth().listUsers({ page, perPage: 200 });
      if (error) throw new ApiError(502, "auth_unavailable", "Could not read the accounts");
      const admins = data.users.filter((u) => (u.app_metadata as { role?: string } | undefined)?.role === "admin");
      out.push(...admins.map(toUser));
      if (data.users.length < 200) break;
    }
    return out;
  }
  return {
    list: all,
    async invite(email) {
      const invited = await auth().inviteUserByEmail(email);
      let user = invited.data.user;
      if (invited.error || !user) {
        // The person already has an account: find it and promote it.
        for (let page = 1; page <= 20 && !user; page++) {
          const { data } = await auth().listUsers({ page, perPage: 200 });
          user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
          if (data.users.length < 200) break;
        }
        if (!user) throw new ApiError(502, "auth_unavailable", "Could not invite this email");
      }
      const { data, error } = await auth().updateUserById(user.id, { app_metadata: { role: "admin" } });
      if (error || !data.user) throw new ApiError(502, "auth_unavailable", "Could not give the admin role");
      return toUser(data.user);
    },
    async demote(id) {
      const { error } = await auth().updateUserById(id, { app_metadata: { role: "customer" } });
      if (error) throw new ApiError(502, "auth_unavailable", "Could not remove the admin role");
    },
  };
}
