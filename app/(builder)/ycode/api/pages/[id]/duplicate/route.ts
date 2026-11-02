import { NextRequest } from 'next/server';
import { duplicatePage } from '@/lib/repositories/pageRepository';
import { noCache } from '@/lib/api-response';
import { reportPageEvent } from '@/lib/services/siteEvents';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/pages/[id]/duplicate
 *
 * Duplicate a page with its draft layers
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const newPage = await duplicatePage(id);
    if (newPage) void reportPageEvent('created', newPage);

    return noCache(
      { data: newPage },
      201
    );
  } catch (error) {
    console.error('[POST /ycode/api/pages/[id]/duplicate] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to duplicate page' },
      500
    );
  }
}
