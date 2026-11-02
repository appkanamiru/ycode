import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getAuthUser, updateUserProfile } from '@/lib/supabase-auth';

/**
 * PUT /ycode/api/profile/name
 *
 * Update user's display name
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string') {
      return noCache({ error: 'Name is required' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    let user;
    try {
      user = await updateUserProfile(auth, { displayName: name.trim() });
    } catch (error) {
      return noCache({ error: error instanceof Error ? error.message : 'Failed to update name' }, 400);
    }

    return noCache({
      data: {
        user,
      },
    });
  } catch (error) {
    console.error('Failed to update name:', error);
    return noCache({ error: 'Failed to update name' }, 500);
  }
}
