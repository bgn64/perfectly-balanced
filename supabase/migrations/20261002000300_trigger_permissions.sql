-- Auth account deletion runs as a restricted role; deferred checks must still
-- see whether cascading deletion removed the parent transaction.
alter function app_private.check_allocations() security definer;
