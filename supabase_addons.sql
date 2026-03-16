-- ============================================================
-- Run this in Supabase SQL Editor to upgrade bot_accounts
-- This is safe to run even if you already ran the main schema
-- ============================================================

-- Add password column if it doesn't exist
alter table bot_accounts add column if not exists fb_password text;

-- Add notes column for any extra info
alter table bot_accounts add column if not exists notes text;

-- Make sure session_file has a default
alter table bot_accounts alter column session_file set default 'pending';

-- Done
