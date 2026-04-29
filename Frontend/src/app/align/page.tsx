"use client";
import React, { useState, useRef, useCallback, useEffect } from "react";
import axios from "axios";

// ── Types ─────────────────────────────────────────────────────────────────────
type TolerancePct = 5 | 10 | 15 | 20 | 25;
type WeightRow = { id: number; column: string; weight: number };
type SegmentRow = {
  name: string;
  color: string;
  threshold: string;
  callFreq: string;
  target: boolean;
};
type AiResult = {
  executive_summary: string;
  outlier_suggestions: { territory: string; issue: string; suggestion: string }[];
  strategic_recommendation: string;
} | null;
type RunResult = { mapHtml: string } | null;

type StepId = "welcome" | "mode" | "data" | "metrics" | "segments" | "sizing" | "done";

interface Message {
  id: string;
  role: "assistant" | "user";
  text: string;
  qid: string;
  chips?: string[];
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const GROQ_KEY = process.env.NEXT_PUBLIC_GROQ_API_KEY || "";

const STEP_LABELS: StepId[] = ["welcome", "mode", "data", "metrics", "segments", "sizing", "done"];

const SEG_COLORS = ["#1D4ED8", "#15803D", "#B45309", "#7C3AED", "#BE185D"];

// ── Groq stubs (fallback if no key) ─────────────────────────────────────────
const STUBS: Record<string, string> = {
  "Q-000": "TerriSense uses your customer and prescription data to automatically draw balanced sales territories — so every rep has a fair, workable workload and no ZIP codes fall through the cracks.",
  "Q-001": "Starting fresh builds territories from the ground up using your data. Re-optimizing keeps your existing boundaries as a starting point and adjusts only what's needed to rebalance workload.",
  "Q-002": "HCP ID uniquely identifies each customer so the system never double-counts, and ZIP links each customer to a geography. Metric columns — like Rx volume — are what the system balances across territories.",
  "Q-003": "Metric weights tell the system how much each data column matters when calculating territory value. They must sum to 100% so the index stays on a consistent scale across all territories.",
  "Q-004": "Segmentation lets you treat different customer types differently — e.g. Segment A gets 12 calls/year while Segment C gets 4. Skip it if all customers follow the same targeting rules.",
  "Q-005": "K is how many territories you need. Index tolerance sets acceptable variance — ±15% means territories range 850–1150. Hard floor is the minimum below which a territory is considered unworkable.",
};

async function fetchGroq(qid: string, prompt: string): Promise<string> {
  if (!GROQ_KEY) return STUBS[qid] || "Connect a Groq API key for AI explanations.";
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 130,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || STUBS[qid];
  } catch {
    return STUBS[qid];
  }
}

// ── Flow definition ───────────────────────────────────────────────────────────
interface FlowStep {
  qid: string;
  stepId: StepId;
  question: string;
  chips: string[];
  groqPrompt: string;
}

const FLOW: FlowStep[] = [
  {
    qid: "Q-000", stepId: "welcome",
    question: "Hi! I'm your TerriSense Alignment Assistant.\n\nI'll guide you through building or optimizing your pharmaceutical territory alignment. Ready to get started?",
    chips: ["Yes, let's go", "Tell me more first"],
    groqPrompt: "In 2 sentences, explain what TerriSense territory alignment software does for pharma sales teams. Plain English, no jargon.",
  },
  {
    qid: "Q-001", stepId: "mode",
    question: "Are you starting a brand new alignment from scratch, or do you have an existing one (ZTT + metrics) you'd like to re-optimize?",
    chips: ["Brand new alignment", "Re-optimize existing"],
    groqPrompt: "In 2 sentences, explain the difference between building a brand new pharma territory alignment vs re-optimizing an existing one. Plain language.",
  },
  {
    qid: "Q-002", stepId: "data",
    question: "I'll need your data file to get started. It requires at minimum an HCP ID and ZIP code, plus at least one metric column (e.g. Rx volume).\n\nUpload your file using the panel on the left, or I can share the Excel template with the correct schema.",
    chips: ["Give me the template", "I'll upload my file"],
    groqPrompt: "In 2 sentences, explain why HCP ID and ZIP code are mandatory fields and what metric columns are used for in territory alignment. Plain English.",
  },
  {
    qid: "Q-003", stepId: "metrics",
    question: "Now let's set your metric weights. These decide how 'territory value' is calculated — for example, Rx volume might count more than call activity.\n\nAdjust the weights on the left until they sum to 100%, then confirm when ready.",
    chips: ["Use suggested defaults", "Weights are set — continue"],
    groqPrompt: "In 2 sentences, explain what metric weighting means in territory alignment and why all weights must sum to 100%. Plain language.",
  },
  {
    qid: "Q-004", stepId: "segments",
    question: "Do you want to segment your customers before running the alignment? Segments (like A/B/C tiers) let you apply different call frequency or targeting rules per group.\n\nYou can add and configure segments in the left panel.",
    chips: ["Yes, configure segments", "No, skip segmentation"],
    groqPrompt: "In 2 sentences, explain what customer segmentation does in pharma field force territory alignment and when it's optional. Plain language.",
  },
  {
    qid: "Q-005", stepId: "sizing",
    question: "Last step — territory sizing. Set your parameters in the left panel:\n\n• How many territories (K)?\n• Index tolerance (±%)?\n• Hard floor (minimum viable index)?\n\nOr tell me your rep headcount and I'll suggest a K value for you.",
    chips: ["I know my K value", "Suggest K from headcount"],
    groqPrompt: "In 2 sentences, explain what K (territory count), index tolerance, and hard floor mean in pharma territory sizing. Plain language.",
  },
];

// ── Main component ────────────────────────────────────────────────────────────
export default function AlignPage() {
  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentFlowIdx, setCurrentFlowIdx] = useState(0);
  const [inputText, setInputText] = useState("");
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("welcome");

  // Left panel state
  const [activeQid, setActiveQid] = useState("—");
  const [groqText, setGroqText] = useState<Record<string, string>>({});
  const [groqLoading, setGroqLoading] = useState(false);
  const [groqStatus, setGroqStatus] = useState<'unknown'|'ok'|'fail'>('unknown');

  // Data
  const [file, setFile] = useState<File | null>(null);
  const [detectedCols, setDetectedCols] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [weights, setWeights] = useState<WeightRow[]>([
    { id: 1, column: "", weight: 50 },
    { id: 2, column: "", weight: 30 },
    { id: 3, column: "", weight: 20 },
  ]);
  const [segments, setSegments] = useState<SegmentRow[]>([
    { name: "Segment A", color: SEG_COLORS[0], threshold: "Rx ≥ 200", callFreq: "12", target: true },
    { name: "Segment B", color: SEG_COLORS[1], threshold: "100 – 199", callFreq: "8", target: true },
    { name: "Segment C", color: SEG_COLORS[2], threshold: "Rx < 100", callFreq: "4", target: false },
  ]);
  const [numClusters, setNumClusters] = useState(50);
  const [tolerance, setTolerance] = useState<TolerancePct>(15);
  const [hardFloor, setHardFloor] = useState(700);
  const [workingDays, setWorkingDays] = useState(220);
  const [callsPerDay, setCallsPerDay] = useState(4);

  // Results
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult>(null);
  const [aiResult, setAiResult] = useState<AiResult>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const totalWeight = weights.reduce((s, r) => s + Number(r.weight || 0), 0);
  const minCap = Math.round(1000 * (1 - tolerance / 100));
  const maxCap = Math.round(1000 * (1 + tolerance / 100));

  // ── Init: show first question ─────────────────────────────────────────────
  useEffect(() => {
    const first = FLOW[0];
    showGroqAndQuestion(first, 0);
    // Check if Groq key is working
    if (GROQ_KEY) {
      fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${GROQ_KEY}` }
      }).then(r => setGroqStatus(r.ok ? 'ok' : 'fail')).catch(() => setGroqStatus('fail'));
    } else {
      setGroqStatus('fail');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Show groq explanation + push question ────────────────────────────────
  async function showGroqAndQuestion(step: FlowStep, _idx: number) {
    setActiveQid(step.qid);
    setCurrentStep(step.stepId);
    setGroqLoading(true);

    // Fetch groq in background
    fetchGroq(step.qid, step.groqPrompt).then((text) => {
      setGroqText((prev) => ({ ...prev, [step.qid]: text }));
      setGroqLoading(false);
    });

    // Push question to chat after short delay
    setTimeout(() => {
      addBotMessage(step.question, step.qid, step.chips);
    }, 400);
  }

  function addBotMessage(text: string, qid: string, chips: string[] = []) {
    setMessages((prev) => [
      ...prev,
      { id: `bot-${Date.now()}`, role: "assistant", text, qid, chips },
    ]);
  }

  function addUserMessage(text: string, qid: string) {
    setMessages((prev) => [
      ...prev,
      { id: `usr-${Date.now()}`, role: "user", text, qid },
    ]);
  }

  // ── Handle user reply ─────────────────────────────────────────────────────
  async function handleReply(text: string, chipContainer?: HTMLDivElement) {
    if (isWaiting || !text.trim()) return;
    setIsWaiting(true);

    // Disable chips
    if (chipContainer) {
      chipContainer.querySelectorAll("button").forEach((b) => {
        (b as HTMLButtonElement).disabled = true;
      });
    }

    const currentFlowStep = FLOW[currentFlowIdx];
    addUserMessage(text, currentFlowStep.qid);

    const nextIdx = currentFlowIdx + 1;
    setCurrentFlowIdx(nextIdx);

    if (nextIdx >= FLOW.length) {
      // End of flow — run generation
      setTimeout(() => {
        addBotMessage(
          "All parameters collected! I'm now running your territory optimization.\n\nThe map, index distribution, and AI analysis will appear in the left panel once complete.",
          "Q-FIN"
        );
        setCurrentStep("done");
        setIsWaiting(false);
        handleGenerate();
      }, 600);
      return;
    }

    await new Promise((r) => setTimeout(r, 700));
    const nextStep = FLOW[nextIdx];
    await showGroqAndQuestion(nextStep, nextIdx);
    setIsWaiting(false);
  }

  function sendFreeText() {
    const text = inputText.trim();
    if (!text || isWaiting) return;
    setInputText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    handleReply(text);
  }

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setDetecting(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await axios.post(`${API}/detect_columns`, fd);
      if (res.data.columns?.length) {
        const cols: string[] = res.data.columns;
        setDetectedCols(cols);
        const eq = Math.floor(100 / cols.length);
        setWeights(
          cols.map((c, i) => ({
            id: i + 1,
            column: c,
            weight: i === cols.length - 1 ? 100 - eq * (cols.length - 1) : eq,
          }))
        );
      }
    } catch { /* silent */ }
    finally { setDetecting(false); }
  }, []);

  // ── Generate territory ────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!file) { setGenError("No file uploaded."); return; }
    setGenerating(true); setGenError(null); setResult(null); setAiResult(null);

    const validW = weights.filter((w) => w.column.trim());
    const cfg: Record<string, number> = {};
    validW.forEach((w) => { cfg[w.column.trim()] = Number(w.weight); });

    const buildFd = () => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("num_clusters", String(numClusters));
      fd.append("column_config", JSON.stringify(cfg));
      fd.append("tolerance_pct", String(tolerance));
      return fd;
    };

    try {
      const [mapRes, xlsRes] = await Promise.allSettled([
        axios.post(`${API}/optimize_map`, buildFd(), { responseType: "text", timeout: 300000 }),
        axios.post(`${API}/optimize_excel`, buildFd(), { responseType: "blob", timeout: 300000 }),
      ]);

      if (xlsRes.status === "fulfilled") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([xlsRes.value.data]));
        a.download = "territory_analysis.xlsx";
        a.click(); a.remove();
      }

      if (mapRes.status === "fulfilled") {
        setResult({ mapHtml: mapRes.value.data });
        setTimeout(() => mapRef.current?.scrollIntoView({ behavior: "smooth" }), 400);

        // AI inference
        setAiLoading(true);
        try {
          const infFd = new FormData();
          infFd.append("k", String(numClusters));
          infFd.append("tolerance_pct", String(tolerance));
          infFd.append("hard_floor", String(hardFloor));
          infFd.append("min_cap", String(minCap));
          infFd.append("max_cap", String(maxCap));
          infFd.append("stats_json", "{}");
          const infRes = await axios.post(`${API}/ai_inference`, infFd, { timeout: 60000 });
          if (infRes.data && !infRes.data.error) setAiResult(infRes.data);
        } catch { /* non-blocking */ }
        finally { setAiLoading(false); }
      } else {
        setGenError("Map generation failed — check backend logs.");
      }
    } catch (err: unknown) {
      setGenError(axios.isAxiosError(err) ? err.message : "Generation failed.");
    } finally { setGenerating(false); }
  }

  // ── Segment helpers ───────────────────────────────────────────────────────
  function addSegment() {
    const color = SEG_COLORS[segments.length % SEG_COLORS.length];
    setSegments((prev) => [
      ...prev,
      { name: `Segment ${String.fromCharCode(65 + prev.length)}`, color, threshold: "", callFreq: "", target: false },
    ]);
  }

  // ── Left panel renderer ───────────────────────────────────────────────────
  function renderLeftPanel() {
    const qid = activeQid;
    const explanation = groqText[qid];

    const GroqBlock = () => (
      <div style={styles.groqBlock}>
        <div style={styles.groqLabel}>AI Insight · {qid}</div>
        {groqLoading && !explanation ? (
          <div style={styles.groqLoading}>
            <span style={styles.dot1} />
            <span style={styles.dot2} />
            <span style={styles.dot3} />
            <span style={{ marginLeft: 8, fontSize: 12, color: "#1D4ED8" }}>Generating…</span>
          </div>
        ) : (
          <div style={styles.groqText}>{explanation}</div>
        )}
      </div>
    );

    if (currentStep === "done" || result || aiLoading || aiResult) {
      return <ResultsPanel />;
    }

    if (currentStep === "welcome" || currentStep === "mode") {
      return (
        <>
          <GroqBlock />
          <div style={styles.infoGrid}>
            <div style={styles.infoCard}>
              <div style={styles.infoCardTitle}>What TerriSense does</div>
              <div style={styles.infoCardBody}>Guides you step-by-step to build or re-optimize pharma sales territories using your HCP data and Rx metrics.</div>
            </div>
            <div style={{ ...styles.infoCard, borderColor: "#C3D4FD", background: "#EFF4FF" }}>
              <div style={{ ...styles.infoCardTitle, color: "#1D4ED8" }}>Powered by Groq AI</div>
              <div style={styles.infoCardBody}>Llama 3.1 explains each step in plain language. The TerriSense backend handles all territory math.</div>
            </div>
          </div>
        </>
      );
    }

    if (currentStep === "data") {
      return (
        <>
          <GroqBlock />
          <div style={styles.card}>
            <div style={styles.cardHead}>Required file schema</div>
            <table style={styles.schemaTbl}>
              <thead>
                <tr>
                  {["Column", "Format", "Status"].map((h) => (
                    <th key={h} style={styles.schemaTh}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["HCP / HCO ID", "String / Int", "req"],
                  ["ZIP code", "5-digit", "req"],
                  ["Metric 1–4", "Numeric", "req"],
                  ["HCP / HCO Name", "String", "opt"],
                  ["City, State", "String", "opt"],
                ].map(([col, fmt, status]) => (
                  <tr key={col}>
                    <td style={styles.schemaTd}>{col}</td>
                    <td style={{ ...styles.schemaTd, fontFamily: "monospace", fontSize: 11 }}>{fmt}</td>
                    <td style={styles.schemaTd}>
                      <span style={status === "req" ? styles.badgeReq : styles.badgeOpt}>
                        {status === "req" ? "Required" : "Optional"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={styles.card}>
            <div style={styles.cardHead}>Upload your file</div>
            <label style={{ ...styles.uploadZone, ...(file ? styles.uploadZoneDone : {}) }}>
              <input type="file" accept=".csv,.xlsx" onChange={handleFile} style={{ display: "none" }} />
              {detecting ? (
                <div style={{ fontSize: 13, color: "#6B7280" }}>Analysing columns…</div>
              ) : file ? (
                <>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
                  <div style={{ fontSize: 13, color: "#15803D", fontWeight: 500 }}>{file.name}</div>
                  <div style={{ fontSize: 11, color: "#6B7280", marginTop: 3 }}>
                    {detectedCols.length} metric columns detected
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>📄</div>
                  <div style={{ fontSize: 13, color: "#6B7280" }}>Drop file here or click to browse</div>
                  <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>Accepts .xlsx · .csv · .xls — max 50 MB</div>
                </>
              )}
            </label>
          </div>
        </>
      );
    }

    if (currentStep === "metrics") {
      return (
        <>
          <GroqBlock />
          <div style={styles.card}>
            <div style={styles.cardHead}>Metric weights</div>
            <div style={{ padding: "14px 16px" }}>
              {weights.map((w, i) => (
                <div key={w.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <input
                      value={w.column}
                      placeholder={detectedCols[i] ? detectedCols[i] : `Metric ${i + 1}`}
                      onChange={(e) => setWeights((prev) => prev.map((r) => r.id === w.id ? { ...r, column: e.target.value } : r))}
                      style={styles.metricName}
                    />
                    <span style={styles.metricPct}>{w.weight}%</span>
                  </div>
                  <input
                    type="range" min={0} max={100} value={w.weight}
                    onChange={(e) => setWeights((prev) => prev.map((r) => r.id === w.id ? { ...r, weight: +e.target.value } : r))}
                    style={{ width: "100%", accentColor: "#1D4ED8" }}
                  />
                </div>
              ))}
              <div style={{ textAlign: "right", fontSize: 12, fontFamily: "monospace", paddingTop: 8, borderTop: "1px solid #E5E7EB" }}>
                Total:{" "}
                <span style={{ color: totalWeight === 100 ? "#15803D" : "#DC2626", fontWeight: 600 }}>
                  {totalWeight}%
                </span>
                {totalWeight !== 100 && <span style={{ color: "#DC2626" }}> — must equal 100%</span>}
              </div>
            </div>
          </div>
        </>
      );
    }

    if (currentStep === "segments") {
      return (
        <>
          <GroqBlock />
          <div style={styles.card}>
            <div style={styles.cardHead}>Customer segments</div>
            <div style={{ padding: "14px 16px" }}>
              {segments.map((seg, i) => (
                <div key={i} style={styles.segRow}>
                  <div style={{ ...styles.segDot, background: seg.color }} />
                  <input
                    value={seg.name}
                    onChange={(e) => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, name: e.target.value } : s))}
                    style={styles.segNameInput}
                  />
                  <select
                    value={seg.threshold}
                    onChange={(e) => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, threshold: e.target.value } : s))}
                    style={styles.segSelect}
                  >
                    {["Rx ≥ 200", "100 – 199", "Rx < 100", "Specialty", "Custom"].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  <input
                    type="number" placeholder="Calls/yr" value={seg.callFreq}
                    onChange={(e) => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, callFreq: e.target.value } : s))}
                    style={styles.segCalls}
                  />
                  <label style={styles.segToggle}>
                    <input
                      type="checkbox" checked={seg.target}
                      onChange={(e) => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, target: e.target.checked } : s))}
                      style={{ marginRight: 4 }}
                    />
                    Target
                  </label>
                </div>
              ))}
              <button onClick={addSegment} style={styles.addSegBtn}>+ Add segment</button>
            </div>
          </div>
        </>
      );
    }

    if (currentStep === "sizing") {
      return (
        <>
          <GroqBlock />
          <div style={styles.statsGrid}>
            {[
              { label: "Territories (K)", val: numClusters, sub: "field reps" },
              { label: "Tolerance", val: `±${tolerance}%`, sub: "index range" },
              { label: "Index target", val: "1,000", sub: "per territory" },
              { label: "Hard floor", val: hardFloor, sub: "min viable" },
            ].map((s) => (
              <div key={s.label} style={styles.statCard}>
                <div style={styles.statLabel}>{s.label}</div>
                <div style={styles.statVal}>{s.val}</div>
                <div style={styles.statSub}>{s.sub}</div>
              </div>
            ))}
          </div>
          <div style={styles.card}>
            <div style={styles.cardHead}>Territory sizing inputs</div>
            <div style={{ padding: "14px 16px" }}>
              <FormRow label="Number of territories (K)" required>
                <input
                  type="number" min={2} max={500} value={numClusters}
                  onChange={(e) => setNumClusters(+e.target.value)}
                  style={styles.formInput}
                />
              </FormRow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormRow label="Tolerance (%)">
                  <select value={tolerance} onChange={(e) => setTolerance(+e.target.value as TolerancePct)} style={styles.formSelect}>
                    {[5, 10, 15, 20, 25].map((v) => <option key={v} value={v}>±{v}%</option>)}
                  </select>
                </FormRow>
                <FormRow label="Hard floor index">
                  <input type="number" value={hardFloor} onChange={(e) => setHardFloor(+e.target.value)} style={styles.formInput} />
                </FormRow>
                <FormRow label="Working days / year">
                  <input type="number" value={workingDays} onChange={(e) => setWorkingDays(+e.target.value)} style={styles.formInput} />
                </FormRow>
                <FormRow label="Calls / day / rep">
                  <input type="number" value={callsPerDay} onChange={(e) => setCallsPerDay(+e.target.value)} style={styles.formInput} />
                </FormRow>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: "#9CA3AF", fontFamily: "monospace" }}>
                Index range: {minCap} – {maxCap}
              </div>
            </div>
          </div>
        </>
      );
    }

    return <GroqBlock />;
  }

  // ── Results panel ─────────────────────────────────────────────────────────
  function ResultsPanel() {
    return (
      <>
        {generating && (
          <div style={styles.generatingCard}>
            <div style={styles.spinner} />
            <div style={{ fontSize: 14, fontWeight: 500, marginTop: 12 }}>Optimizing territories…</div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>This may take up to 2 minutes</div>
          </div>
        )}
        {genError && (
          <div style={styles.errorCard}>{genError}</div>
        )}
        {(aiLoading || aiResult) && (
          <div style={styles.aiPanel}>
            <div style={styles.aiPanelHead}>
              <span style={styles.aiPanelTitle}>AI Territory Analysis</span>
              <span style={styles.aiPanelBadge}>Groq · Llama 3.1</span>
            </div>
            <div style={{ padding: 18 }}>
              {aiLoading && !aiResult && (
                <div style={{ color: "#6B7280", fontSize: 13 }}>Generating AI insights…</div>
              )}
              {aiResult && (
                <>
                  <div style={styles.aiSection}>
                    <div style={styles.aiSectionTitle}>Executive summary</div>
                    <div style={styles.aiText}>{aiResult.executive_summary}</div>
                  </div>
                  {aiResult.outlier_suggestions.length > 0 && (
                    <div style={styles.aiSection}>
                      <div style={styles.aiSectionTitle}>Outlier territories ({aiResult.outlier_suggestions.length})</div>
                      {aiResult.outlier_suggestions.map((s, i) => (
                        <div key={i} style={styles.aiCard}>
                          <div style={styles.aiCardTitle}>{s.territory}</div>
                          <div style={styles.aiCardIssue}>⚠ {s.issue}</div>
                          <div style={styles.aiCardSug}>✓ {s.suggestion}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={styles.aiSection}>
                    <div style={styles.aiSectionTitle}>Strategic recommendation</div>
                    <div style={styles.aiText}>{aiResult.strategic_recommendation}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {result && (
          <div ref={mapRef} style={styles.mapPanel}>
            <div style={styles.mapHead}>Territory map — K={numClusters}</div>
            <iframe srcDoc={result.mapHtml} title="Territory map" style={styles.mapIframe} />
          </div>
        )}
        {!generating && !result && !aiLoading && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: "#9CA3AF", fontSize: 13 }}>
            Results will appear here once generation completes.
          </div>
        )}
      </>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Topbar */}
      <div style={styles.topbar}>
        <div style={styles.logo}>
          Terri<span style={{ color: "#1D4ED8" }}>Sense</span>
        </div>
        <div style={styles.pill}>Alignment Assistant</div>
        <div style={{
          fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 20, border: '1px solid',
          background: groqStatus === 'ok' ? '#F0FDF4' : groqStatus === 'fail' ? '#FEF2F2' : '#FFFBEB',
          color: groqStatus === 'ok' ? '#15803D' : groqStatus === 'fail' ? '#B91C1C' : '#B45309',
          borderColor: groqStatus === 'ok' ? '#BBF7D0' : groqStatus === 'fail' ? '#FECACA' : '#FDE68A',
        }}>
          Groq {groqStatus === 'ok' ? '● connected' : groqStatus === 'fail' ? '● no key' : '● checking…'}
        </div>
        <div style={styles.progress}>
          {STEP_LABELS.slice(0, -1).map((s, i) => {
            const idx = STEP_LABELS.indexOf(currentStep);
            const done = i < idx;
            const active = i === idx;
            return (
              <React.Fragment key={s}>
                {i > 0 && <span style={styles.progressSep}>›</span>}
                <span style={{ ...styles.progressStep, ...(active ? styles.progressActive : done ? styles.progressDone : {}) }}>
                  <span style={styles.progressDot} />
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div style={styles.main}>
        {/* LEFT: AI context + forms */}
        <div style={styles.leftPanel}>
          <div style={styles.panelHeader}>
            <span style={styles.panelTag}>AI Context &amp; Input Forms</span>
            <span style={styles.activeQid}>{activeQid}</span>
          </div>
          <div style={styles.leftBody}>
            {renderLeftPanel()}
          </div>
        </div>

        {/* RIGHT: Questions + replies */}
        <div style={styles.rightPanel}>
          <div style={styles.chatHeader}>
            <div style={styles.avatar}>TS</div>
            <div>
              <div style={styles.chatName}>TerriSense</div>
              <div style={styles.chatStatus}>
                <span style={styles.statusDot} /> Ready
              </div>
            </div>
          </div>

          <div style={styles.chatMessages}>
            {messages.map((msg, mi) => (
              <div key={msg.id}>
                {msg.role === "assistant" ? (
                  <div style={styles.qMsg}>
                    <div style={styles.qMsgQid}>{msg.qid}</div>
                    <div style={styles.qMsgRow}>
                      <div style={styles.msgAvatar}>TS</div>
                      <div style={styles.qBubble}>
                        {msg.text.split("\n").map((line, li) => (
                          <React.Fragment key={li}>
                            {line}
                            {li < msg.text.split("\n").length - 1 && <br />}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                    {msg.chips && msg.chips.length > 0 && (
                      <div
                        style={styles.chips}
                        ref={(el) => {
                          if (!el) return;
                          // attach chip handlers
                          el.querySelectorAll("button").forEach((btn) => {
                            btn.addEventListener("click", () => handleReply(btn.textContent || "", el as HTMLDivElement), { once: true });
                          });
                        }}
                      >
                        {msg.chips.map((c) => (
                          <button key={c} style={styles.chip}
                            onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.background = "#1D4ED8"; (e.target as HTMLButtonElement).style.color = "#fff"; }}
                            onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "#EFF4FF"; (e.target as HTMLButtonElement).style.color = "#1D4ED8"; }}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={styles.uMsg}>
                    <div style={styles.uMsgQid}>{msg.qid}</div>
                    <div style={styles.uBubble}>{msg.text}</div>
                  </div>
                )}
                {mi === messages.length - 1 && isWaiting && (
                  <div style={styles.typingRow}>
                    <div style={styles.msgAvatar}>TS</div>
                    <div style={styles.typingBubble}>
                      <span style={styles.tdot1} /><span style={styles.tdot2} /><span style={styles.tdot3} />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div ref={chatBottomRef} />
          </div>

          <div style={styles.inputArea}>
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => { setInputText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 90) + "px"; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFreeText(); } }}
              placeholder="Type your reply or select an option above…"
              rows={1}
              style={styles.textarea}
            />
            <button onClick={sendFreeText} style={styles.sendBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── FormRow helper ────────────────────────────────────────────────────────────
function FormRow({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={styles.formLabel}>
        {required && <span style={styles.reqDot} />}
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'IBM Plex Sans', 'Segoe UI', sans-serif", background: "#F4F3EF", color: "#1C1B18", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", fontSize: 13.5 },
  topbar: { display: "flex", alignItems: "center", padding: "0 18px", height: 48, background: "#fff", borderBottom: "1px solid #E2E0D8", gap: 10, flexShrink: 0 },
  logo: { fontWeight: 600, fontSize: 15, letterSpacing: -0.3 },
  pill: { fontSize: 10, fontWeight: 500, background: "#EFF4FF", color: "#1D4ED8", border: "1px solid #C3D4FD", borderRadius: 20, padding: "2px 8px", fontFamily: "monospace" },
  progress: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" },
  progressStep: { display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "#D1D0C8", fontFamily: "monospace" },
  progressActive: { color: "#1D4ED8" },
  progressDone: { color: "#15803D" },
  progressDot: { width: 5, height: 5, borderRadius: "50%", background: "currentColor" },
  progressSep: { fontSize: 10, color: "#D1D0C8", margin: "0 2px" },
  main: { display: "flex", flex: 1, overflow: "hidden" },

  // Left panel
  leftPanel: { width: "55%", borderRight: "1px solid #E2E0D8", display: "flex", flexDirection: "column", background: "#fff" },
  panelHeader: { padding: "12px 18px 10px", borderBottom: "1px solid #E2E0D8", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  panelTag: { fontSize: 10, fontWeight: 500, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "monospace" },
  activeQid: { marginLeft: "auto", fontFamily: "monospace", fontSize: 10, color: "#9CA3AF", background: "#F4F3EF", padding: "2px 7px", borderRadius: 4, border: "1px solid #E2E0D8" },
  leftBody: { flex: 1, overflowY: "auto", padding: 18 },

  // Groq block
  groqBlock: { background: "#EFF4FF", border: "1px solid #C3D4FD", borderRadius: 8, padding: "12px 14px", marginBottom: 14 },
  groqLabel: { fontSize: 10, fontFamily: "monospace", color: "#1D4ED8", fontWeight: 500, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.6 },
  groqText: { fontSize: 13, color: "#1e3a8a", lineHeight: 1.65 },
  groqLoading: { display: "flex", alignItems: "center", gap: 4 },
  dot1: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#1D4ED8", opacity: 1, animation: "bounce 1.2s infinite" },
  dot2: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#1D4ED8", opacity: 1, animation: "bounce 1.2s infinite 0.2s" },
  dot3: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#1D4ED8", opacity: 1, animation: "bounce 1.2s infinite 0.4s" },

  // Cards
  card: { background: "#fff", border: "1px solid #E2E0D8", borderRadius: 10, marginBottom: 14, overflow: "hidden" },
  cardHead: { padding: "9px 14px", borderBottom: "1px solid #E2E0D8", fontSize: 12, fontWeight: 500, color: "#6B7280", background: "#FAFAF8" },

  // Info grid
  infoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  infoCard: { padding: 14, border: "1px solid #E2E0D8", borderRadius: 8, background: "#FAFAF8" },
  infoCardTitle: { fontSize: 11, fontWeight: 500, color: "#6B7280", marginBottom: 5 },
  infoCardBody: { fontSize: 12, color: "#1C1B18", lineHeight: 1.6 },

  // Schema table
  schemaTbl: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  schemaTh: { textAlign: "left", padding: "5px 10px", background: "#F5F4F0", color: "#6B7280", fontWeight: 500, fontFamily: "monospace", fontSize: 10.5, borderBottom: "1px solid #E2E0D8" },
  schemaTd: { padding: "7px 10px", borderBottom: "1px solid #F0EEE8", color: "#1C1B18" },
  badgeReq: { fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 20, fontFamily: "monospace", background: "#FEF2F2", color: "#B91C1C" },
  badgeOpt: { fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 20, fontFamily: "monospace", background: "#F0FDF4", color: "#15803D" },

  // Upload
  uploadZone: { display: "block", border: "1.5px dashed #E2E0D8", borderRadius: 8, padding: "22px 16px", textAlign: "center", cursor: "pointer", background: "#F9FAFB", transition: "all .2s", margin: "14px 16px" },
  uploadZoneDone: { borderColor: "#15803D", background: "#F0FDF4" },

  // Metric
  metricName: { flex: 1, border: "1px solid #E2E0D8", borderRadius: 6, padding: "5px 8px", fontSize: 12, fontFamily: "inherit", color: "#1C1B18", outline: "none", background: "#FAFAF8" },
  metricPct: { fontFamily: "monospace", fontSize: 12, color: "#1D4ED8", fontWeight: 500, minWidth: 36, textAlign: "right" },

  // Segments
  segRow: { display: "flex", alignItems: "center", gap: 8, padding: "9px 0", borderBottom: "1px solid #F0EEE8" },
  segDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  segNameInput: { flex: 1, border: "none", background: "transparent", fontFamily: "inherit", fontSize: 13, color: "#1C1B18", outline: "none" },
  segSelect: { width: 110, padding: "5px 6px", border: "1px solid #E2E0D8", borderRadius: 6, fontSize: 11, fontFamily: "inherit", color: "#1C1B18", background: "#fff", outline: "none" },
  segCalls: { width: 72, padding: "5px 6px", border: "1px solid #E2E0D8", borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: "#1C1B18", background: "#fff", outline: "none", textAlign: "right" },
  segToggle: { fontSize: 11, color: "#6B7280", display: "flex", alignItems: "center", cursor: "pointer", flexShrink: 0 },
  addSegBtn: { marginTop: 10, width: "100%", padding: 7, border: "1px dashed #E2E0D8", borderRadius: 6, background: "transparent", color: "#9CA3AF", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },

  // Stats
  statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 },
  statCard: { background: "#FAFAF8", border: "1px solid #E2E0D8", borderRadius: 8, padding: "11px 13px" },
  statLabel: { fontSize: 10, color: "#9CA3AF", fontFamily: "monospace", marginBottom: 3 },
  statVal: { fontSize: 18, fontWeight: 500, color: "#1C1B18" },
  statSub: { fontSize: 10, color: "#6B7280", marginTop: 2 },

  // Form
  formLabel: { display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 500, color: "#6B7280", marginBottom: 4, fontFamily: "monospace" },
  reqDot: { width: 4, height: 4, borderRadius: "50%", background: "#DC2626", flexShrink: 0 },
  formInput: { width: "100%", padding: "7px 10px", border: "1px solid #E2E0D8", borderRadius: 6, fontFamily: "inherit", fontSize: 13, color: "#1C1B18", background: "#fff", outline: "none" },
  formSelect: { width: "100%", padding: "7px 10px", border: "1px solid #E2E0D8", borderRadius: 6, fontFamily: "inherit", fontSize: 13, color: "#1C1B18", background: "#fff", outline: "none", appearance: "none" },

  // Right panel
  rightPanel: { width: "45%", display: "flex", flexDirection: "column", background: "#F4F3EF" },
  chatHeader: { padding: "12px 18px 10px", borderBottom: "1px solid #E2E0D8", background: "#fff", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  avatar: { width: 28, height: 28, borderRadius: "50%", background: "#1D4ED8", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10, fontWeight: 600, flexShrink: 0 },
  chatName: { fontSize: 13, fontWeight: 500 },
  chatStatus: { fontSize: 11, color: "#15803D", display: "flex", alignItems: "center", gap: 3 },
  statusDot: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#15803D" },
  chatMessages: { flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 },

  // Messages
  qMsg: { display: "flex", flexDirection: "column", gap: 3 },
  qMsgQid: { fontFamily: "monospace", fontSize: 9.5, color: "#B8B6AD", paddingLeft: 2 },
  qMsgRow: { display: "flex", alignItems: "flex-start", gap: 7 },
  msgAvatar: { width: 22, height: 22, borderRadius: "50%", background: "#1D4ED8", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 9, fontWeight: 600, flexShrink: 0, marginTop: 2 },
  qBubble: { background: "#fff", border: "1px solid #E2E0D8", borderRadius: "10px 10px 10px 3px", padding: "10px 13px", fontSize: 13, lineHeight: 1.6, maxWidth: "92%" },
  uMsg: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 },
  uMsgQid: { fontFamily: "monospace", fontSize: 9.5, color: "#B8B6AD", paddingRight: 2 },
  uBubble: { background: "#1D4ED8", color: "#fff", borderRadius: "10px 10px 3px 10px", padding: "9px 13px", fontSize: 13, maxWidth: "88%", lineHeight: 1.5 },
  chips: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4, paddingLeft: 30 },
  chip: { padding: "5px 11px", border: "1px solid #C3D4FD", borderRadius: 20, fontSize: 12, color: "#1D4ED8", cursor: "pointer", background: "#EFF4FF", fontFamily: "inherit", transition: "all .15s" },

  // Typing
  typingRow: { display: "flex", alignItems: "center", gap: 7, marginTop: 8 },
  typingBubble: { background: "#fff", border: "1px solid #E2E0D8", borderRadius: 8, padding: "8px 12px", display: "flex", gap: 4 },
  tdot1: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#B8B6AD" },
  tdot2: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#B8B6AD" },
  tdot3: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#B8B6AD" },

  // Input
  inputArea: { padding: "10px 14px 12px", borderTop: "1px solid #E2E0D8", background: "#fff", display: "flex", gap: 8, alignItems: "flex-end", flexShrink: 0 },
  textarea: { flex: 1, border: "1px solid #E2E0D8", borderRadius: 8, padding: "8px 11px", fontFamily: "inherit", fontSize: 13, color: "#1C1B18", resize: "none", outline: "none", minHeight: 36, maxHeight: 90, background: "#F4F3EF", lineHeight: 1.5 },
  sendBtn: { width: 34, height: 34, borderRadius: 8, background: "#1D4ED8", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flexShrink: 0 },

  // Results
  generatingCard: { textAlign: "center", padding: "32px 20px", background: "#EFF4FF", borderRadius: 10, border: "1px solid #C3D4FD", marginBottom: 14 },
  spinner: { width: 36, height: 36, border: "3px solid #E2E0D8", borderTopColor: "#1D4ED8", borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto" },
  errorCard: { background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#B91C1C", marginBottom: 14 },
  aiPanel: { background: "#fff", border: "1px solid #E2E0D8", borderRadius: 10, marginBottom: 14, overflow: "hidden" },
  aiPanelHead: { display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#0F172A", borderBottom: "1px solid #E2E0D8" },
  aiPanelTitle: { fontSize: 13, fontWeight: 600, color: "#fff" },
  aiPanelBadge: { fontSize: 10, background: "rgba(255,255,255,.18)", color: "#fff", padding: "3px 8px", borderRadius: 20 },
  aiSection: { marginBottom: 16 },
  aiSectionTitle: { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#1D4ED8", marginBottom: 8, fontFamily: "monospace" },
  aiText: { fontSize: 13, lineHeight: 1.65, color: "#374151" },
  aiCard: { background: "#F9FAFB", border: "1px solid #E2E0D8", borderRadius: 8, padding: "12px 14px", marginBottom: 8 },
  aiCardTitle: { fontSize: 12, fontWeight: 600, color: "#1C1B18", marginBottom: 4 },
  aiCardIssue: { fontSize: 11, color: "#B91C1C", marginBottom: 5, lineHeight: 1.4 },
  aiCardSug: { fontSize: 11, color: "#15803D", lineHeight: 1.4 },
  mapPanel: { background: "#fff", border: "1px solid #E2E0D8", borderRadius: 10, overflow: "hidden", marginBottom: 14 },
  mapHead: { padding: "10px 16px", borderBottom: "1px solid #E2E0D8", fontSize: 13, fontWeight: 600, color: "#1C1B18" },
  mapIframe: { width: "100%", height: 520, border: "none", display: "block" },
};
