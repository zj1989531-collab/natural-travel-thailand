-- Historical production migration marker. The baseline contains the final
-- brand-normalization trigger but not the original one-time data rewrite.
do $$ begin null; end $$;
