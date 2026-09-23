ALTER TABLE "competitor_comparisons" ADD COLUMN IF NOT EXISTS "submitted_competitor_urls" jsonb;
--> statement-breakpoint
ALTER TABLE "competitor_comparisons" ADD COLUMN IF NOT EXISTS "blocked_urls" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_comparisons_user_primary_created_idx" ON "competitor_comparisons" USING btree ("user_id", "primary_brand_domain", "created_at");
