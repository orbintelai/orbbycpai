"use client";
import React, { useState } from "react";
import Link from "next/link";

interface TeaserProfile {
  meta: { brandName: string; url: string };
  primaryColor: string;
  accentColor: string;
  colorPalette: Array<{ hex: string; count: number }>;
  typography: {
    headline: { fontFamily?: string };
    body: { fontFamily?: string };
  };
  tone: { summary: string; directness: string; formality: string };
  brandArchetype?: { archetype: string; rationale: string };
  brandPersonality: string;
  industryContext: string;
  shapeLanguage: { classification: string };
  brandAssets: { favicon?: string; ogImage?: string; logoImgs?: string[] };
  productIntelligence: {
    productName: string;
    oneLiner: string;
    productCategory: string[];
    productType: string;
  };
}

const ARCHETYPES_EMOJI: Record<string, string> = {
  "The Innocent": "☀️",
  "The Sage": "🦉",
  "The Explorer": "🧭",
  "The Outlaw": "⚡",
  "The Magician": "✨",
  "The Hero": "🏆",
  "The Lover": "❤️",
  "The Jester": "🎭",
  "The Everyman": "🤝",
  "The Caregiver": "🌿",
  "The Ruler": "👑",
  "The Creator": "🎨",
};

export default function BrandExtractionPanel() {
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [teaserProfile, setTeaserProfile] = useState<TeaserProfile | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleAnalyze = async () => {
    if (!url.trim()) return;
    setStep("loading");
    setStatusMsg("Reading the live company site...");
    setTeaserProfile(null);
    setErrorMsg("");

    const normalized = url.startsWith("http") ? url : `https://${url}`;

    // Rotate status messages while loading
    const msgs = ["Reading the live company site...", "Classifying company signals...", "Preparing your preview..."];
    let msgIdx = 0;
    const msgTimer = setInterval(() => {
      msgIdx = (msgIdx + 1) % msgs.length;
      setStatusMsg(msgs[msgIdx]);
    }, 3000);

    try {
      const res = await fetch("/api/extract-teaser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });

      clearInterval(msgTimer);
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setErrorMsg("Preview capacity is temporarily full. Create an account for beta access.");
        } else {
          setErrorMsg(data.error || "Analysis failed. Please try again.");
        }
        setStep("error");
        return;
      }

      setTeaserProfile(data.teaserProfile);
      setStep("done");
    } catch {
      clearInterval(msgTimer);
      setErrorMsg("Network error. Please try again.");
      setStep("error");
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: 680 }}>
      {/* URL Input */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
        padding: "10px 14px",
        marginBottom: 12,
      }}>
        <span style={{ fontSize: 16, color: "rgba(0,212,170,0.7)", flexShrink: 0 }}>⊕</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="yourwebsite.com or a competitor URL"
          disabled={step === "loading"}
          onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            fontSize: 15,
            color: url ? "var(--text-primary)" : "rgba(255,255,255,0.35)",
            fontFamily: "monospace",
            letterSpacing: "0.01em",
          }}
        />
        <button
          onClick={handleAnalyze}
          disabled={!url.trim() || step === "loading"}
          style={{
            background: !url.trim() || step === "loading" ? "rgba(0,212,170,0.15)" : "#00d4aa",
            color: !url.trim() || step === "loading" ? "rgba(0,212,170,0.5)" : "#000",
            border: "none",
            borderRadius: 8,
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 600,
            cursor: !url.trim() || step === "loading" ? "not-allowed" : "pointer",
            transition: "all 0.15s",
            boxShadow: !url.trim() || step === "loading" ? "none" : "0 0 16px rgba(0,212,170,0.35)",
            whiteSpace: "nowrap",
          }}
        >
          {step === "loading" ? "Analyzing..." : "Analyze company →"}
        </button>
      </div>

      {/* Loading state */}
      {step === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", justifyContent: "center" }}>
          <div style={{
            width: 16, height: 16, borderRadius: "50%",
            border: "2px solid rgba(0,212,170,0.25)",
            borderTopColor: "#00d4aa",
            animation: "spin 0.8s linear infinite",
          }} />
          <span style={{ fontSize: 13, color: "rgba(0,212,170,0.8)", fontFamily: "monospace" }}>{statusMsg}</span>
        </div>
      )}

      {/* Error state */}
      {step === "error" && (
        <div style={{
          background: "rgba(255,80,80,0.08)",
          border: "1px solid rgba(255,80,80,0.2)",
          borderRadius: 10,
          padding: "12px 16px",
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <span style={{ fontSize: 13, color: "rgba(255,100,100,0.9)" }}>{errorMsg}</span>
          <button
            onClick={() => setStep("idle")}
            style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      )}

      {/* Teaser Result Card */}
      {step === "done" && teaserProfile && (
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          overflow: "hidden",
          marginTop: 8,
          textAlign: "left",
        }}>
          {/* Brand header */}
          <div style={{
            padding: "16px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: `linear-gradient(135deg, ${teaserProfile.primaryColor}18 0%, transparent 60%)`,
          }}>
            {teaserProfile.brandAssets?.favicon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={teaserProfile.brandAssets.favicon}
                alt=""
                width={28}
                height={28}
                style={{ borderRadius: 6, objectFit: "contain" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>
                {teaserProfile.productIntelligence.productName || teaserProfile.meta.brandName}
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                {teaserProfile.industryContext} · {teaserProfile.productIntelligence.productType}
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00d4aa" }} />
              <span style={{ fontSize: 11, color: "#00d4aa", fontFamily: "monospace" }}>analyzed</span>
            </div>
          </div>

          {/* Two-column grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {/* Color Palette */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Color Palette
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {teaserProfile.colorPalette.slice(0, 5).map((c, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: c.hex,
                      border: "1px solid rgba(255,255,255,0.08)",
                    }} />
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>
                      {c.hex.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Typography */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Typography
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Heading</span>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>
                    {teaserProfile.typography.headline.fontFamily || "—"}
                  </div>
                </div>
                <div>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Body</span>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)" }}>
                    {teaserProfile.typography.body.fontFamily || "—"}
                  </div>
                </div>
              </div>
            </div>

            {/* Tone */}
            <div style={{ padding: "14px 20px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Tone of Voice
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[teaserProfile.tone.summary, teaserProfile.tone.directness, teaserProfile.tone.formality]
                  .filter(Boolean)
                  .map((t, i) => (
                    <span key={i} style={{
                      fontSize: 11, color: "rgba(255,255,255,0.6)",
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 100,
                      padding: "3px 10px",
                    }}>
                      {t}
                    </span>
                  ))}
              </div>
            </div>

            {/* Archetype */}
            <div style={{ padding: "14px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Brand Archetype
              </div>
              {teaserProfile.brandArchetype ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 20 }}>
                    {ARCHETYPES_EMOJI[teaserProfile.brandArchetype.archetype] || "✦"}
                  </span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
                      {teaserProfile.brandArchetype.archetype}
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2, lineHeight: 1.4 }}>
                      {(teaserProfile.brandArchetype.rationale || "").slice(0, 80)}
                      {(teaserProfile.brandArchetype.rationale?.length || 0) > 80 ? "..." : ""}
                    </div>
                  </div>
                </div>
              ) : (
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>—</span>
              )}
            </div>
          </div>

          {/* Gated CTA */}
          <div style={{
            padding: "16px 20px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(0,212,170,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "rgba(255,255,255,0.7)" }}>
                Create your beta account
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
                Five full company profiles per calendar month · AI Perception · Competitor Comparison · Source-backed evidence
              </div>
            </div>
            <Link
              href="/register"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#00d4aa",
                color: "#000",
                border: "none",
                borderRadius: 8,
                padding: "9px 18px",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
                whiteSpace: "nowrap",
                boxShadow: "0 0 16px rgba(0,212,170,0.35)",
              }}
            >
              Get started free →
            </Link>
          </div>
        </div>
      )}

      {step === "idle" && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-tertiary)", textAlign: "center" }}>
          Free while in beta · Five full company profiles per calendar month · No credit card
        </p>
      )}
    </div>
  );
}
