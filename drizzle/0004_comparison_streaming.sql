ALTER TABLE "competitor_comparisons" ADD COLUMN "primary_generation_id" uuid;
--> statement-breakpoint
ALTER TABLE "competitor_comparisons" ADD COLUMN "competitor_generation_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "competitor_comparisons" ADD CONSTRAINT "competitor_comparisons_primary_generation_id_generations_id_fk" FOREIGN KEY ("primary_generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "competitor_comparisons_primary_generation_idx" ON "competitor_comparisons" USING btree ("primary_generation_id");
--> statement-breakpoint
CREATE TABLE "competitor_strategist_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "comparison_id" uuid NOT NULL,
  "primary_generation_id" uuid NOT NULL,
  "competitor_generation_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_strategist_results_comparison_member_unique" UNIQUE("comparison_id", "competitor_generation_id")
);
--> statement-breakpoint
ALTER TABLE "competitor_strategist_results" ADD CONSTRAINT "competitor_strategist_results_comparison_id_competitor_comparisons_id_fk" FOREIGN KEY ("comparison_id") REFERENCES "public"."competitor_comparisons"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competitor_strategist_results" ADD CONSTRAINT "competitor_strategist_results_primary_generation_id_generations_id_fk" FOREIGN KEY ("primary_generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competitor_strategist_results" ADD CONSTRAINT "competitor_strategist_results_competitor_generation_id_generations_id_fk" FOREIGN KEY ("competitor_generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "competitor_strategist_results_comparison_idx" ON "competitor_strategist_results" USING btree ("comparison_id");
