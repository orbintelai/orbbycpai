CREATE TABLE "analysis_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"module" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"field_path" text NOT NULL,
	"source_url" text NOT NULL,
	"source_page_title" text NOT NULL,
	"excerpt" text NOT NULL,
	"captured_at" timestamp NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_usage_periods" (
	"calendar_month" text PRIMARY KEY NOT NULL,
	"shared_reserved_runs" integer DEFAULT 0 NOT NULL,
	"admin_reserved_runs" integer DEFAULT 0 NOT NULL,
	"shared_completed_runs" integer DEFAULT 0 NOT NULL,
	"admin_completed_runs" integer DEFAULT 0 NOT NULL,
	"shared_released_runs" integer DEFAULT 0 NOT NULL,
	"admin_released_runs" integer DEFAULT 0 NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"alerted_at_50" boolean DEFAULT false NOT NULL,
	"alerted_at_80" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_usage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_month" text NOT NULL,
	"reserved_runs" integer DEFAULT 0 NOT NULL,
	"completed_runs" integer DEFAULT 0 NOT NULL,
	"released_runs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_periods_user_month_unique" UNIQUE("user_id","calendar_month")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "generations_limit" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "run_origin" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "snapshot_version" integer;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "previous_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "access_tier" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "module_statuses" jsonb;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "runtime_ms" integer;--> statement-breakpoint
ALTER TABLE "analysis_evidence" ADD CONSTRAINT "analysis_evidence_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage_periods" ADD CONSTRAINT "user_usage_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_evidence_generation_module_idx" ON "analysis_evidence" USING btree ("generation_id","module");--> statement-breakpoint
CREATE INDEX "analysis_evidence_source_url_idx" ON "analysis_evidence" USING btree ("source_url");--> statement-breakpoint
CREATE INDEX "generations_domain_completed_idx" ON "generations" USING btree ("domain","completed_at");--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_domain_snapshot_version_unique" UNIQUE("domain","snapshot_version");