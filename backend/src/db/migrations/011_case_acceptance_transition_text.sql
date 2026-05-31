-- Migration 011: Replace transition_completed (boolean) with transition_notes (text).
-- The "Transition" column now captures free-form notes (TP explained, objections, etc.)
-- rather than a simple Y/N flag.
--
-- Step 1: Add the new text column.
ALTER TABLE case_acceptances ADD COLUMN transition_notes text;

-- Step 2: Carry forward existing boolean data as readable text so no history is lost.
UPDATE case_acceptances
   SET transition_notes = 'Done'
 WHERE transition_completed IS TRUE;

-- Step 3: Drop the old boolean column.
ALTER TABLE case_acceptances DROP COLUMN transition_completed;
