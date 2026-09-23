ALTER TABLE "competitor_comparisons" ADD COLUMN "submitted_competitor_urls" jsonb;
--> statement-breakpoint
ALTER TABLE "competitor_comparisons" ADD COLUMN "blocked_urls" jsonb;
--> statement-breakpoint
CREATE INDEX "competitor_comparisons_user_primary_created_idx" ON "competitor_comparisons" USING btree ("user_id", "primary_brand_domain", "created_at");
