import Link from "next/link";
import Image from "next/image";
import UfoHero from "@/components/UfoHero";
import BrandExtractionPanel from "@/components/BrandExtractionPanel";

const signals = [
  ["01", "Key People", "Publicly listed leadership and team signals, linked to the company page that names them."],
  ["02", "News Signals", "Recent first-party launches, partnerships, leadership news, and company updates."],
  ["03", "Hiring Signals", "Open roles, hiring concentration, locations, and seniority patterns from public careers sources."],
  ["04", "AI Perception", "ChatGPT, Claude, and Gemini analyzed side by side—clearly labeled as model analysis, never company fact."],
  ["05", "Competitive Set", "Neutral positioning analysis across a company and up to three selected competitors."],
  ["06", "Product & Pricing", "Published product claims, audience cues, calls to action, and accessible pricing language."],
  ["07", "Compliance & Trust", "First-party security, privacy, and compliance claims with direct source references."],
  ["08", "Integrations & Stack", "Publicly listed integrations, partner ecosystems, and marketplace signals."],
  ["09", "Visual Identity", "Color, typography, shape language, and visual-system cues from the live experience."],
  ["10", "Voice & Archetype", "Positioning, tone, and communication patterns extracted from the company’s own language."],
] as const;

export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#070808" }}>
      <nav style={{ borderBottom: "1px solid var(--border-subtle)", background: "rgba(8,8,8,0.85)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Image src="/orb-logo.png" alt="Orb" width={110} height={50} style={{ display: "block" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link href="/login" style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", padding: "6px 14px", borderRadius: "var(--radius-md)", textDecoration: "none" }}>Sign in</Link>
            <Link href="/register" style={{ fontSize: 13, fontWeight: 650, color: "#000", background: "var(--brand-primary)", padding: "7px 16px", borderRadius: "var(--radius-md)", textDecoration: "none", boxShadow: "0 0 20px var(--brand-glow)" }}>Get started free</Link>
          </div>
        </div>
      </nav>

      <section style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)", padding: "58px 24px 70px", textAlign: "center", overflow: "hidden" }}>
        <UfoHero />
        <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", maxWidth: 790, width: "100%" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "var(--brand-subtle)", border: "1px solid rgba(0,212,170,0.25)", borderRadius: 100, padding: "5px 12px", marginBottom: 26 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand-primary)", boxShadow: "0 0 8px var(--brand-primary)" }} />
            <span style={{ fontSize: 11, fontWeight: 650, color: "var(--brand-primary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>On-demand company intelligence</span>
          </div>
          <h1 style={{ margin: "0 0 18px", padding: 0, lineHeight: 1.02, letterSpacing: "-0.045em" }}>
            <span style={{ display: "block", fontSize: "clamp(42px, 6vw, 76px)", fontWeight: 750, color: "#ffffff" }}>Know the company.</span>
            <span style={{ display: "block", fontSize: "clamp(42px, 6vw, 76px)", fontWeight: 750, color: "#00d4aa" }}>Before the call.</span>
          </h1>
          <p style={{ fontSize: "clamp(15px, 1.8vw, 18px)", color: "var(--text-secondary)", maxWidth: 610, lineHeight: 1.65, margin: "0 0 30px" }}>
            Give Orb a company URL. It turns public first-party signals, live-site intelligence, and three distinct model perspectives into one sourced, decision-ready profile.
          </p>
          <BrandExtractionPanel />
        </div>
      </section>

      <section style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px 96px", width: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.09)" }}>
          {[
            ["PROBLEM", "Company research is still a browser-tab exercise. Before a call, pitch, or investment discussion, the relevant facts are scattered across a site, a newsroom, a careers page, and a dozen assumptions."],
            ["BUILT", "Orb turns a URL into a durable company snapshot. First-party facts include a source reference. AI Perception and Competitive Position name their contributing model source, so model analysis never masquerades as verified fact."],
            ["RESULT", "A repeatable pre-call brief: what the company is signaling, who it is hiring, what it has shipped, where it sits in the category, and what changed since the last read."],
          ].map(([label, copy]) => <div key={label} style={{ display: "grid", gridTemplateColumns: "116px 1fr", gap: 30, padding: "31px 0 31px 29px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}><div style={{ color: "var(--brand-primary)", fontSize: 10, fontWeight: 750, letterSpacing: "0.1em", paddingTop: 4 }}>{label}</div><p style={{ color: "rgba(255,255,255,0.66)", fontSize: 15, lineHeight: 1.75, margin: 0 }}>{copy}</p></div>)}
        </div>
      </section>

      <section style={{ maxWidth: 1120, margin: "0 auto", padding: "0 24px 100px", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <div style={{ color: "#50e3c2", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>One URL. One evidence-backed read.</div>
          <h2 style={{ fontSize: "clamp(27px, 3.4vw, 42px)", fontWeight: 720, letterSpacing: "-0.035em", color: "var(--text-primary)", margin: "0 0 10px" }}>Everything that matters before the conversation.</h2>
          <p style={{ fontSize: 15, color: "var(--text-secondary)", maxWidth: 540, margin: "0 auto", lineHeight: 1.6 }}>Orb separates sourced company facts from model analysis—and keeps the evidence with the report.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(245px, 1fr))", gap: 12 }}>
          {signals.map(([number, title, body]) => <div key={title} className="surface" style={{ padding: 22, minHeight: 170, position: "relative" }}><div style={{ color: "rgba(80,227,194,0.55)", fontSize: 10, fontWeight: 750, letterSpacing: "0.08em", marginBottom: 18 }}>{number}</div><h3 style={{ fontSize: 15, fontWeight: 650, color: "var(--text-primary)", margin: "0 0 8px", letterSpacing: "-0.01em" }}>{title}</h3><p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.65, margin: 0 }}>{body}</p></div>)}
        </div>
      </section>

      <section style={{ maxWidth: 1120, margin: "0 auto", padding: "0 24px 100px", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 42 }}><h2 style={{ fontSize: "clamp(27px, 3vw, 38px)", fontWeight: 720, letterSpacing: "-0.03em", color: "var(--text-primary)", margin: 0 }}>For anyone who needs to know a company fast.</h2></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          {[
            ["Sales", "Enter a prospect before discovery. Arrive knowing their published priorities, hiring motion, language, and category context."],
            ["Investors", "Build a consistent first-pass read on market signals, public positioning, and competitor context without losing the source trail."],
            ["Founders", "See where your narrative overlaps with the market, what competitors are claiming, and what has materially changed."],
            ["Agencies", "Walk into a working session with a sourced company brief—not a collection of tabs and a vague point of view."],
          ].map(([role, use]) => <div key={role} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "20px 22px" }}><div style={{ fontSize: 11, fontWeight: 750, color: "var(--brand-primary)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 9 }}>{role}</div><p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65, margin: 0 }}>{use}</p></div>)}
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--border-subtle)", padding: 24, textAlign: "center" }}><p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0 }}>© 2026 Orb · contentproduction.ai</p></footer>
    </main>
  );
}
