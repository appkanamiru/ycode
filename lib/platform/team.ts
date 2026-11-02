/**
 * Team (multi-tenant platform)
 *
 * The members of a site are its organization's members; invitations are
 * Better Auth invitations, emailed with a link to /ycode/accept-invite.
 * These handlers back the existing user-management routes
 * (/ycode/api/auth/users, /ycode/api/auth/invite) when running on plain
 * Postgres, returning the same response shapes the settings UI expects.
 * Changes go through Better Auth, which checks the caller's permissions too.
 */

import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { ASSIGNABLE_ROLES, canManageMembers, resolveRole, type UserRole } from '@/lib/roles';
import { getPlatformAuth } from './auth';
import { PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';
import { authErrorResponse } from './http';
import { countOwnedSites } from './sites';
import { resolveBuilderAccess, type BuilderAccess } from './tenants';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The caller and their active site; owners and admins manage the team */
async function requireTeamManager(): Promise<(BuilderAccess & { tenantId: string }) | Response> {
  if (!isMultiTenant()) {
    return noCache({ error: 'Team management requires multi-tenant mode' }, 400);
  }
  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);
  if (!access.tenantId) return noCache({ error: 'No active site' }, 403);
  if (!canManageMembers(access.role)) return noCache({ error: 'Insufficient permissions' }, 403);
  return access as BuilderAccess & { tenantId: string };
}

interface MemberRow {
  member_id: string;
  user_id: string;
  role: string;
}

async function findMember(siteId: string, userId: string): Promise<MemberRow | null> {
  const { rows } = await getPlatformPool().query<MemberRow>(
    `select id as member_id, "userId" as user_id, role from ${PLATFORM_SCHEMA}.member
     where "organizationId" = $1 and "userId" = $2`,
    [siteId, userId],
  );
  return rows[0] ?? null;
}

async function isPendingInvitation(siteId: string, invitationId: string): Promise<boolean> {
  const { rows } = await getPlatformPool().query(
    `select 1 from ${PLATFORM_SCHEMA}.invitation where id::text = $1 and "organizationId" = $2 and status = 'pending'`,
    [invitationId, siteId],
  );
  return rows.length > 0;
}

/** GET /ycode/api/auth/users */
export async function handleTeamList(): Promise<Response> {
  if (!isMultiTenant()) {
    return noCache({ error: 'Team management requires multi-tenant mode' }, 400);
  }
  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);
  if (!access.tenantId) return noCache({ error: 'No active site' }, 403);

  const pool = getPlatformPool();
  const [{ rows: members }, { rows: invitations }] = await Promise.all([
    pool.query(
      `select u.id, u.email, u.name, u.image, m.role, m."createdAt" as created_at
       from ${PLATFORM_SCHEMA}.member m join ${PLATFORM_SCHEMA}."user" u on u.id = m."userId"
       where m."organizationId" = $1 order by m."createdAt"`,
      [access.tenantId],
    ),
    pool.query(
      `select id, email, role, "createdAt" as invited_at from ${PLATFORM_SCHEMA}.invitation
       where "organizationId" = $1 and status = 'pending' and "expiresAt" > now() order by "createdAt"`,
      [access.tenantId],
    ),
  ]);

  return noCache({
    data: {
      activeUsers: members.map((member) => ({
        id: member.id,
        email: member.email,
        display_name: member.name || null,
        avatar_url: member.image || null,
        role: resolveRole(member.role),
        created_at: new Date(member.created_at).toISOString(),
        last_sign_in_at: null,
      })),
      pendingInvites: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: resolveRole(invitation.role),
        invited_at: new Date(invitation.invited_at).toISOString(),
      })),
      callerRole: access.role,
    },
  });
}

/** POST /ycode/api/auth/invite  { email, role } — also resends a pending invitation */
export async function handleTeamInvite(request: Request): Promise<Response> {
  const caller = await requireTeamManager();
  if (caller instanceof Response) return caller;

  const body = await request.json().catch(() => ({})) as { email?: unknown; role?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(email)) return noCache({ error: 'Invalid email format' }, 400);

  const role = (ASSIGNABLE_ROLES as readonly string[]).includes(body.role as string) ? body.role as UserRole : 'designer';
  if (role === 'admin' && caller.role !== 'owner') {
    return noCache({ error: 'Only the owner can assign the admin role' }, 403);
  }

  try {
    await getPlatformAuth().api.createInvitation({
      headers: await headers(),
      body: { email, role, organizationId: caller.tenantId, resend: true },
    });
    return noCache({ data: { role, message: `Invitation sent to ${email}` } });
  } catch (error) {
    return authErrorResponse(error, 'Failed to send invitation');
  }
}

/** PATCH /ycode/api/auth/users?id=<user id>  { role } */
export async function handleTeamRoleChange(request: Request): Promise<Response> {
  const caller = await requireTeamManager();
  if (caller instanceof Response) return caller;

  const userId = new URL(request.url).searchParams.get('id');
  const { role } = await request.json().catch(() => ({})) as { role?: string };
  if (!userId) return noCache({ error: 'ID is required' }, 400);
  if (!role || !(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    return noCache({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` }, 400);
  }
  if (role === 'admin' && caller.role !== 'owner') {
    return noCache({ error: 'Only the owner can assign the admin role' }, 403);
  }

  const target = await findMember(caller.tenantId, userId);
  if (!target) return noCache({ error: 'Member not found' }, 404);
  if (target.role === 'owner') return noCache({ error: 'Cannot change the owner\'s role' }, 400);
  if (target.role === 'admin' && caller.role !== 'owner') {
    return noCache({ error: 'Only the owner can change an admin\'s role' }, 403);
  }

  try {
    await getPlatformAuth().api.updateMemberRole({
      headers: await headers(),
      body: { memberId: target.member_id, role, organizationId: caller.tenantId },
    });
    return noCache({ data: { success: true } });
  } catch (error) {
    return authErrorResponse(error, 'Failed to update role');
  }
}

/** DELETE /ycode/api/auth/users?id=<user id | invitation id> — remove a member or cancel an invitation */
export async function handleTeamRemove(request: Request): Promise<Response> {
  const caller = await requireTeamManager();
  if (caller instanceof Response) return caller;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return noCache({ error: 'User ID is required' }, 400);

  try {
    if (await isPendingInvitation(caller.tenantId, id)) {
      await getPlatformAuth().api.cancelInvitation({ headers: await headers(), body: { invitationId: id } });
      return noCache({ data: { success: true } });
    }

    if (id === caller.user.id) return noCache({ error: 'Cannot remove yourself' }, 400);
    const target = await findMember(caller.tenantId, id);
    if (!target) return noCache({ error: 'Member not found' }, 404);
    if (target.role === 'owner') return noCache({ error: 'Cannot remove the owner' }, 400);
    if (target.role === 'admin' && caller.role !== 'owner') {
      return noCache({ error: 'Only the owner can remove an admin' }, 403);
    }

    // Removes the membership only; the account and its other sites stay
    await getPlatformAuth().api.removeMember({
      headers: await headers(),
      body: { memberIdOrEmail: target.member_id, organizationId: caller.tenantId },
    });
    return noCache({ data: { success: true } });
  } catch (error) {
    return authErrorResponse(error, 'Failed to remove member');
  }
}

/** POST /ycode/api/platform/invitations/accept  { invitationId } */
export async function handleInvitationAccept(request: Request): Promise<Response> {
  const { invitationId } = await request.json().catch(() => ({})) as { invitationId?: unknown };
  if (typeof invitationId !== 'string' || !invitationId) {
    return noCache({ error: 'invitationId is required' }, 400);
  }

  try {
    const requestHeaders = await headers();
    // Fails unless the invitation was sent to the signed-in user's email
    const result = await getPlatformAuth().api.acceptInvitation({ headers: requestHeaders, body: { invitationId } });
    const organizationId = result?.invitation.organizationId;
    if (organizationId) {
      await getPlatformAuth().api.setActiveOrganization({ headers: requestHeaders, body: { organizationId } });
    }
    return noCache({ data: { siteId: organizationId } });
  } catch (error) {
    return authErrorResponse(error, 'Failed to accept the invitation');
  }
}

/** DELETE /ycode/api/profile — the account goes, its memberships with it */
export async function handleAccountDelete(): Promise<Response> {
  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);

  // Sites must keep an owner
  if (await countOwnedSites(access.user.id) > 0) {
    return noCache({ error: 'You own sites. Delete them or transfer their ownership first.' }, 400);
  }

  // Sessions, accounts and memberships are removed with the user
  await getPlatformPool().query(`delete from ${PLATFORM_SCHEMA}."user" where id = $1`, [access.user.id]);
  return noCache({ data: { success: true } });
}
