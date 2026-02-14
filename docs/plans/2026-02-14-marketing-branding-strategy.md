# Marketing & Branding Strategy — Chorus

> Status: **DEFERRED** — Saved for post-production-readiness phase
> Created: 2026-02-14
> Priority: Execute after backend gaps are resolved and app reaches commercial-grade

---

## 1. Product Identity

- **Product Name**: Chorus
- **Tagline**: "Every voice counts" / "每一次面试，都有据可循"
- **Package Name**: `interview-feedback-desktop`
- **Version**: 0.1.0 (MVP)
- **Domains**: `frontierace.ai` (inference), `api.frontierace.ai` (edge worker)

## 2. Brand Positioning

**One-liner**: Real-time interview recording + AI-structured candidate feedback desktop tool

**Positioning Statement**:
> Chorus captures every voice in group interviews and generates fair, evidence-backed feedback instantly.
> Built for hiring teams who want rigorous, unbiased hiring.

**Design Aesthetic**:
- Warm neutral palette (Granola-inspired): linen background `#F6F2EA`, teal accent `#0D6A63`
- Typography: Inter (sans-serif), JetBrains Mono (evidence quotes)
- Visual Style: Neo-brutalist, clean whitespace, card-based, glassmorphism accents

## 3. Target Audience

| User Layer | Role | Pain Point | Buy Motivation |
|-----------|------|-----------|---------------|
| **Core** | HR / Hiring Manager | Scattered notes, subjective feedback | Standardized process + reduce bias |
| **Decision Maker** | HR Director/VP | Hiring quality unmeasurable | Compliance + efficiency + data-driven |
| **Extended** | Interview Coach | Can't quantify candidate progress | Objective assessment + development tracking |

**JTBD**: "I need to fairly evaluate multiple candidates in real-time without distraction, and generate actionable feedback immediately with cited evidence."

## 4. Competitive Landscape

| Dimension | Chorus | Granola | Otter.ai | Metaview | BrightHire |
|-----------|--------|---------|----------|----------|-----------|
| Platform | Mac desktop | Mac desktop | Web/Mobile | Web | Web |
| Speaker ID | Voiceprint enrollment + manual mapping | Limited | Transcript inference only | Limited | Limited |
| Real-time Feedback | <1s first screen | Yes | No (post-meeting) | Partial | No |
| Evaluation Templates | Customizable dimensions | Built-in | N/A | Limited | Template-based |
| Evidence Linking | Timestamped + speaker attribution | Yes | Yes | Limited | Limited |
| Privacy | Local inference option | Unknown | Cloud-only | Cloud | Cloud |

**3 Key Differentiators**:
1. Voiceprint-level speaker identification (not guessing)
2. Dual-stream audio capture (mic + system audio isolation)
3. Local inference option (for sensitive industries)

## 5. Marketing Strategies (Prioritized)

### Strategy 1: Engineering as Marketing — Free Interview Rubric Builder
- Web tool: select interview type → auto-generate scoring sheet
- SEO targets: "interview rubric template", "structured interview scorecard"
- CTA: "Want AI to fill this automatically? Try Chorus"
- Expected: 5K-20K monthly visits, 3-5% waitlist conversion
- Resources: 1 week dev, $0

### Strategy 2: LinkedIn Audience Building — Founder Brand
- 2-3 posts/week: interview bias data, Chorus insights, HR tech trends
- Share proprietary data: "We found 30% of candidates speak less than 20% of interview time"
- Expected: 2K-5K target audience in 3 months
- Resources: 3-4 hours/week writing, $0

### Strategy 3: Product Hunt Launch
- 2-min demo video (Setup → Notes → AI Report)
- Landing page: "Like Granola, but built for hiring teams"
- Pre-launch: 2 weeks Twitter/LinkedIn momentum
- Expected: Top 5 daily, 500-2000 signups
- Resources: 2 weeks prep, $0-500

### Strategy 4: Competitor Comparison Pages
- Individual pages: "Chorus vs Granola", "Chorus vs Metaview", "Chorus vs Otter"
- Focus on differentiators: voiceprint, dual-stream, local deployment
- Expected: 200-500 monthly search volume per page, 8-15% conversion
- Resources: 1 week content

### Strategy 5: Proprietary Data Content — Interview Fairness Report
- Annual report: "Interview Fairness Analysis" from anonymized beta data
- Distribute to HR media (SHRM, ERE, LinkedIn)
- Expected: Media citations + backlinks + brand authority
- Resources: Data collection + 2 weeks content

## 6. Branding Roadmap

| Phase | Timeline | Tasks | Deliverables |
|-------|----------|-------|-------------|
| Brand Foundation | Week 1-2 | Logo, color spec, typography guide | Brand Kit PDF |
| Landing Page | Week 2-3 | Product homepage + beta signup | frontierace.ai landing |
| Demo Video | Week 3-4 | 2-min product walkthrough | YouTube + embed |
| Content Seed | Week 4-6 | 3 blog posts + LinkedIn calendar | Blog + Social |
| PH Launch | Week 6-8 | Product Hunt prep + assets | PH listing |

## 7. Marketing-Driven Feature Priorities

| Priority | Feature | Marketing Value | Status |
|---------|---------|----------------|--------|
| P0 | Demo Mode (no real interview needed) | Let prospects experience core value in 5 min | Not implemented |
| P0 | Beautiful PDF export | Shared reports = free advertising | Has Markdown/Text, no PDF |
| P1 | Template marketplace | SEO + community + stickiness | Basic templates exist |
| P1 | Team collaboration (share reports) | Seat expansion = revenue growth | Not implemented |
| P2 | Web preview mode | Lower experience barrier | Desktop only |
| P2 | ATS integration | Enterprise purchase requirement | Not implemented |

---

## Next Steps (When Ready)

1. Finalize Brand Kit (logo + spec)
2. Build Landing Page (frontierace.ai)
3. Implement Demo Mode (pre-recorded audio + simulated AI report)
4. Record 2-min product demo video
5. Create "Interview Rubric Builder" free tool
6. Prepare Product Hunt launch
7. Write competitor comparison pages
8. Publish first data report
