-- Historical production migration marker. The preceding baseline already
-- contains its final schema state. Retained so local and remote histories use
-- the same timestamp without rewriting production history.
do $$ begin null; end $$;
