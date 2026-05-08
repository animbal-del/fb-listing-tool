-- ============================================================
-- Run this on the ORIGINAL Supabase (not Denner's).
-- Changes post_queue.property_id from uuid to bigint to match
-- inventory_flats.id in Denner's system.
--
-- WARNING: existing rows will have property_id set to NULL
-- because UUID values cannot be converted to bigint.
-- Active campaigns will lose their property references and
-- should be re-created after migrating property data.
-- ============================================================

-- 1. Drop the FK constraint (can't reference a cross-instance table)
ALTER TABLE public.post_queue
  DROP CONSTRAINT IF EXISTS post_queue_property_id_fkey;

-- 2. Change the column type — existing UUIDs become NULL
ALTER TABLE public.post_queue
  ALTER COLUMN property_id TYPE bigint USING NULL;

-- 3. Rebuild the index on the new type
DROP INDEX IF EXISTS public.idx_post_queue_bot;
CREATE INDEX IF NOT EXISTS idx_post_queue_property ON public.post_queue(property_id);

SELECT 'post_queue.property_id migrated to bigint ✅' AS result;
