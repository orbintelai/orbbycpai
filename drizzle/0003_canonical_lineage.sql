CREATE TABLE "domain_lineage_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alias_registrable_domain" text NOT NULL,
  "canonical_registrable_domain" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "first_generation_id" uuid,
  "confirmed_by_user_id" uuid,
  "confirmed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "domain_lineage_aliases_alias_registrable_domain_unique" UNIQUE("alias_registrable_domain")
);
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "submitted_url" text;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "resolved_url" text;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "declared_canonical_url" text;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "registrable_domain" text;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "redirect_chain" jsonb;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "lineage_status" text;
--> statement-breakpoint
ALTER TABLE "domain_lineage_aliases" ADD CONSTRAINT "domain_lineage_aliases_first_generation_id_generations_id_fk" FOREIGN KEY ("first_generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_lineage_aliases" ADD CONSTRAINT "domain_lineage_aliases_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "domain_lineage_aliases_canonical_idx" ON "domain_lineage_aliases" USING btree ("canonical_registrable_domain");
--> statement-breakpoint
CREATE INDEX "generations_registrable_domain_completed_idx" ON "generations" USING btree ("registrable_domain", "completed_at");
