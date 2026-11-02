import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getAuthUser, updateUserProfile } from '@/lib/supabase-auth';
import { getSupabaseStorage } from '@/lib/supabase-storage';
import { STORAGE_BUCKET, STORAGE_FOLDERS } from '@/lib/asset-constants';
import { generateId } from '@/lib/utils';
import sharp from 'sharp';

/**
 * POST /ycode/api/profile/avatar
 *
 * Upload user's profile photo
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return noCache({ error: 'No file provided' }, 400);
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      return noCache({ error: 'Only image files are allowed' }, 400);
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      return noCache({ error: 'File size must be less than 5MB' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const bucket = (await getSupabaseStorage()).from(STORAGE_BUCKET);

    // Convert image to WebP and resize for avatar
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const webpBuffer = await sharp(buffer)
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();

    // Create storage path: avatars/{userId}-{randomId}.webp
    const storagePath = `${STORAGE_FOLDERS.AVATARS}/${generateId(auth.user.id)}.webp`;

    // Delete old avatar if exists
    const oldAvatarUrl = auth.user.user_metadata?.avatar_url;
    if (oldAvatarUrl) {
      try {
        // Storage path = public URL minus the bucket's URL prefix
        const bucketUrl = bucket.getPublicUrl('_').data.publicUrl.slice(0, -1);
        if (oldAvatarUrl.startsWith(bucketUrl)) {
          await bucket.remove([decodeURIComponent(oldAvatarUrl.slice(bucketUrl.length))]);
        }
      } catch (error) {
        console.error('Failed to delete old avatar:', error);
        // Continue even if deletion fails
      }
    }

    // Upload new avatar
    const { data: uploadData, error: uploadError } = await bucket
      .upload(storagePath, webpBuffer, {
        cacheControl: '3600',
        upsert: true,
        contentType: 'image/webp',
      });

    if (uploadError) {
      console.error('Failed to upload avatar:', uploadError);
      return noCache({ error: `Failed to upload avatar: ${uploadError.message}` }, 500);
    }

    // Get public URL
    const { data: urlData } = bucket.getPublicUrl(uploadData.path);

    // Update user metadata with new avatar URL
    let user;
    try {
      user = await updateUserProfile(auth, { avatarUrl: urlData.publicUrl });
    } catch (updateError) {
      console.error('Failed to update user metadata:', updateError);
      return noCache({ error: 'Failed to update profile' }, 500);
    }

    return noCache({
      data: {
        avatar_url: urlData.publicUrl,
        user,
      },
    });
  } catch (error) {
    console.error('Failed to upload avatar:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return noCache({ error: `Failed to upload avatar: ${message}` }, 500);
  }
}
